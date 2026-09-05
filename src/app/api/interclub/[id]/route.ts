import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import {
  interclubInclude,
  serializeInterclub,
  parseTimeInput,
  parseOptionalText,
  derivedStatus,
  MAX_OPPONENT_LEN,
  MAX_DIVISION_LEN,
  MAX_VENUE_LEN,
  MAX_VENUE_ADDRESS_LEN,
  MAX_ROUND_LEN,
  type FullInterclub,
} from "@/lib/interclub-db";
import { HttpError, httpErrorResponse, serializableTransaction } from "@/lib/http-tx";
import { teamRoster } from "@/lib/interclub-roster";
import { interclubChanged } from "@/lib/interclub-gate";
import { isRealDateISO } from "@/lib/time";
import { matchKey } from "@/lib/squashnet/calendar";
import { notifyFixtureMoved } from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/{id} : état complet de la rencontre (matchs, jeux, direct éventuel).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;
  const f = await prisma.interclub.findUnique({ where: { id }, include: interclubInclude });
  if (!f) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }

  // Composition possible : STRICTEMENT le roster de l'équipe qui dispute la rencontre —
  // ses membres inscrits ET ses joueurs sans compte. Règle voulue du club, appliquée côté
  // serveur à l'écriture (cf. `resolveHomePick`) ; ce qu'on renvoie ici n'est que de quoi
  // remplir le sélecteur. Composer suppose donc d'avoir été rattaché à l'équipe par un admin.
  const roster = await teamRoster(f.teamId);

  // Statut admin lu sur la SESSION, déjà chargée : ce `GET` est rejoué à chaque retour au
  // premier plan, un `user.findUnique` de moins y est une économie Neon réelle.
  const view = { ...serializeInterclub(f, session.userId, isAdminEmail(session.email)), roster };
  // Auto-cicatrisation : le statut DÉDUIT fait foi. Si la colonne a divergé (dernier score
  // saisi ailleurs, rencontre laissée « en cours »), on la recale pour que la LISTE soit juste.
  //
  // ⚠️ ÉCRITURE CONDITIONNELLE, et non un `update` simple. On lit puis on écrit la même ligne
  // hors transaction : entre les deux, une écriture de score peut avoir posé le vrai statut.
  // Un `update` inconditionnel l'écrasait alors avec une valeur calculée sur un état déjà mort
  // — deux téléphones au bord du terrain suffisent. Le `where` reprend la valeur LUE : si elle
  // a bougé, la clause ne trouve rien et ce GET, qui n'est qu'un lecteur, se tait.
  if (view.status !== f.status) {
    await prisma.interclub
      .updateMany({ where: { id, status: f.status }, data: { status: view.status } })
      .catch(() => {});
  }
  return NextResponse.json(view);
}

/**
 * PATCH /api/interclub/{id} — corriger une rencontre : sa date, son heure, son lieu, son
 * adversaire, sa journée de championnat.
 *
 * POURQUOI CETTE ROUTE EXISTE. Une rencontre créée n'était PAS modifiable : seuls `GET` et
 * `DELETE` existaient. Tant qu'une rencontre s'inscrivait la veille au soir, on pouvait la
 * supprimer et la refaire. Depuis qu'un calendrier de championnat entier est saisi en septembre
 * et que la ligue reporte des journées en cours de saison, supprimer/recréer perdrait la
 * composition ET les disponibilités déjà recueillies — c'est-à-dire tout le travail.
 *
 * Droits : créateur ou admin, exactement comme `DELETE`. Pas de règle nouvelle à retenir.
 *
 * ⚠️ TOUT CE QUI DÉPEND DE L'ÉTAT DE LA RENCONTRE EST ATOMIQUE (Serializable + retry P2034),
 * comme les routes sœurs `PATCH …/matches/{mid}` et `POST …/live`. Cette route lisait la
 * rencontre une fois, puis décidait sur cette lecture et écrivait dans une transaction
 * ORDINAIRE — donc en Read Committed, sans réessai. Deux courses en sortaient :
 *
 *   - la garde « déjà commencée » sautait. Un point saisi au bord du terrain pendant la requête,
 *     et la date changeait sur une soirée en cours : les disponibilités effacées, l'appel
 *     relancé. C'est exactement ce que la garde existe pour empêcher ;
 *   - le déplacement devenait FANTÔME. A déplace au 16, l'équipe recommence à répondre ; le
 *     `PATCH` de B, encore parti sur l'ancienne date, effaçait ces réponses fraîches et
 *     annonçait « déplacée depuis le 3 » — un déplacement que personne n'a vécu.
 *
 * Le `GET` juste au-dessus documente la même classe de défaut et s'en protège autrement (une
 * écriture conditionnelle) : là-bas rien n'est en jeu qu'une colonne recalculable, ici ce sont
 * les réponses de l'équipe.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;
  const admin = isAdminEmail(session.email);

  // LA GARDE DES DROITS RESTE DEHORS, et elle seule.
  //
  // Un droit ne court aucun risque de concurrence : personne ne cesse d'être créateur ni admin
  // pendant sa propre requête. La laisser ici préserve l'ordre observable — 404, puis 403, puis
  // les 400 du corps — auquel ce fichier tient (cf. « le 403 passe AVANT le 409 » côté DELETE),
  // et évite d'ouvrir une transaction Serializable pour quelqu'un qui n'a pas le droit d'écrire.
  const droit = await prisma.interclub.findUnique({ where: { id }, select: { createdById: true } });
  if (!droit) return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  if (droit.createdById !== session.userId && !admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // LES CHAMPS ISSUS DU CORPS SEUL, validés hors transaction parce que cette validation est
  // PURE : elle ne lit pas la rencontre, et refuser un corps mal formé ne mérite pas d'ouvrir
  // une connexion Neon. Ce qui dépend de l'état lu — le déplacement, la clé d'ancrage — s'ajoute
  // dedans, sur une copie.
  const data: Record<string, unknown> = {};

  if (body.date !== undefined) {
    if (typeof body.date !== "string" || !isRealDateISO(body.date)) {
      return NextResponse.json({ error: "Date invalide" }, { status: 400 });
    }
    data.date = body.date;
  }

  const time = parseTimeInput(body.time);
  if (body.time !== undefined) {
    if (!time.ok) return NextResponse.json({ error: "Heure invalide (attendu HH:MM)" }, { status: 400 });
    data.time = time.value;
  }

  if (body.opponent !== undefined) {
    const v = parseOptionalText(body.opponent, MAX_OPPONENT_LEN);
    // Seul champ NON nullable du lot : une rencontre sans adversaire ne veut rien dire, et la
    // colonne le refuserait de toute façon — autant le dire ici, en français.
    if (!v.ok || !v.value) {
      return NextResponse.json({ error: "Nom du club adverse manquant" }, { status: 400 });
    }
    data.opponent = v.value;
  }

  // LES QUATRE CHAMPS TEXTE FACULTATIFS, et la distinction qui manquait.
  //
  // « Absent » (on ne touche pas), « `null` explicite » (on efface) et « mal typé » (on refuse)
  // se confondaient en un seul cas : `parseOptionalText` rendait `null` pour tout ce qui n'était
  // pas une chaîne, donc `PATCH {"venue": 42}` répondait 200 et le lieu disparaissait. Sur le
  // même corps, `opponent` juste au-dessus rendait un 400 : un champ refusait, quatre effaçaient
  // en silence. Le nom du champ est dans le message, sans quoi un 400 sur un corps à six clés
  // n'apprend rien.
  const textes: [string, unknown, number][] = [
    ["division", body.division, MAX_DIVISION_LEN],
    // La JOURNÉE figurait dans le contrat de cette fonction sans y être traitée : une rencontre
    // importée dont la ligue renumérote la journée n'était corrigible d'aucune façon.
    ["round", body.round, MAX_ROUND_LEN],
    ["venue", body.venue, MAX_VENUE_LEN],
    ["venueAddress", body.venueAddress, MAX_VENUE_ADDRESS_LEN],
  ];
  for (const [nom, brut, max] of textes) {
    if (brut === undefined) continue;
    const v = parseOptionalText(brut, max);
    if (!v.ok) return NextResponse.json({ error: `Champ « ${nom} » invalide` }, { status: 400 });
    data[nom] = v.value;
  }

  if (typeof body.home === "boolean") data.home = body.home;
  // LE RATTRAPAGE DE LA DATE PRÉVISIONNELLE. La détection automatique a deux angles morts
  // (cf. `ownFixtures`, lib/squashnet/calendar.ts) : deux vraies journées le même soir passent
  // pour prévisionnelles, et une seule journée non planifiée passe pour ferme. C'est ce booléen,
  // posé à la main, qui les corrige — et c'est pour lui que `dateConfirmed` est une colonne et
  // non un calcul refait à chaque lecture. L'import le SAIT : il pose la déduction sur une
  // rencontre qu'il découvre, mais ne réécrit jamais celle-ci sur une rencontre connue ; il
  // signale l'écart et laisse la correction en place (`CalendarDiff.confirmDrift`).
  if (typeof body.dateConfirmed === "boolean") data.dateConfirmed = body.dateConfirmed;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Rien à modifier." }, { status: 400 });
  }

  /**
   * Ce qu'il faudra ANNONCER une fois le commit acquis.
   *
   * C'est la valeur de RETOUR de la transaction, et non une variable remplie au passage — même
   * raison que `PATCH …/matches/{mid}` : sur rejeu après conflit, le corps repart de zéro et
   * produit sa propre valeur, là où une variable partagée devrait être remise à zéro à la main.
   * Un oubli notifierait deux fois.
   */
  type Annonce = {
    ctx: { fixtureId: string; teamId: string; teamName: string; opponent: string };
    from: string;
    to: { date: string; time: string | null };
  };

  let resultat: { updated: FullInterclub | null; annonce: Annonce | null };
  try {
    resultat = await serializableTransaction(async (tx) => {
      const f = await tx.interclub.findUnique({
        where: { id },
        include: { team: true, matches: { select: { gamesHome: true, status: true } } },
      });
      // Disparue entre la garde et ici : quelqu'un vient de la supprimer. Le 404 est le même
      // qu'au-dessus — l'appelant n'a pas à savoir laquelle des deux lectures a échoué.
      if (!f) throw new HttpError(404, "Rencontre introuvable");

      // UNE COPIE FRAÎCHE À CHAQUE TENTATIVE. `data` vient du corps et survit au rejeu : y poser
      // `availabilityOpenedAt` ou `snMatchKey` les laisserait derrière soi, et la tentative
      // suivante repartirait d'un objet déjà enrichi par la précédente — enrichi sur un état
      // qu'elle n'a pas lu.
      const ecriture: Record<string, unknown> = { ...data };

      let movedFrom: string | null = null;
      if (typeof ecriture.date === "string" && ecriture.date !== f.date) {
        // Une rencontre COMMENCÉE ne se déplace pas : le déplacement efface les disponibilités
        // et relance l'appel, ce qui n'a aucun sens sur une soirée déjà en cours ou jouée. Le
        // reste (lieu mal orthographié, adversaire à corriger) demeure modifiable après coup.
        //
        // La lecture est celle de la TRANSACTION : c'est là tout l'intérêt. Sur la lecture de
        // garde, un point saisi entre les deux faisait passer la rencontre pour à venir.
        if (derivedStatus(f.matchCount, f.matches) !== "scheduled") {
          throw new HttpError(409, "Rencontre déjà commencée : sa date ne peut plus changer.");
        }
        movedFrom = f.date;

        // --- DÉPLACER UNE RENCONTRE INVALIDE LES RÉPONSES --------------------------------------
        // « Je suis dispo le 9 » ne veut pas dire « je suis dispo le 16 ». Garder les réponses
        // ferait composer l'équipe sur des « oui » qui ne veulent plus rien dire — et ce sont
        // précisément les soirs de report qu'on se retrouve à trois. On efface, et on relance
        // l'appel en remettant les marqueurs à zéro pour que le cron repose la question.
        ecriture.availabilityOpenedAt = null;
        ecriture.availabilityRemindedAt = null;
      }

      // LA CLÉ D'ANCRAGE SUIT LA JOURNÉE, sans quoi corriger celle-ci ne corrige rien.
      //
      // `snMatchKey` vaut `événement:journée`, et c'est sur elle SEULE que l'import rapproche. La
      // journée était modifiable, la clé non : la ligue renumérotait J1 en J01 — les deux formes
      // existent dans les fixtures du dépôt —, l'admin corrigeait `round` à la main, et l'import
      // suivant créait quand même un DOUBLON. L'ancienne rencontre, avec sa composition et ses
      // réponses, n'était plus jamais rapprochée, et le cron annonçait chaque lundi
      // « J1 retirée du calendrier ».
      //
      // Seul le suffixe change : l'événement reste celui sur lequel la rencontre a été importée,
      // lu ici et non sur la garde. Une rencontre SAISIE À LA MAIN n'a pas de clé et n'en gagne
      // pas — l'automatique et l'humain ne partagent aucune colonne.
      if (typeof ecriture.round === "string" && f.snMatchKey) {
        const eventId = f.snMatchKey.slice(0, f.snMatchKey.indexOf(":"));
        if (eventId) ecriture.snMatchKey = matchKey(eventId, ecriture.round);
      }

      if (movedFrom) await tx.interclubAvailability.deleteMany({ where: { interclubId: id } });
      await tx.interclub.update({ where: { id }, data: ecriture });
      const updated = await tx.interclub.findUnique({ where: { id }, include: interclubInclude });

      return {
        updated,
        annonce:
          movedFrom && updated
            ? {
                ctx: {
                  fixtureId: id,
                  teamId: f.teamId,
                  teamName: f.team.name,
                  opponent: updated.opponent,
                },
                from: movedFrom,
                to: { date: updated.date, time: updated.time },
              }
            : null,
      };
    }, "Modification concurrente, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }

  interclubChanged();

  if (resultat.annonce) {
    // Après le commit, jamais avant : annoncer un déplacement qui n'a pas eu lieu serait pire
    // que de ne rien annoncer. Et HORS de la boucle de réessai — un envoi qui échoue ne doit ni
    // annuler l'écriture, qui est valide, ni déclencher un rejeu, qui notifierait deux fois.
    // Best-effort par ailleurs : `notifyFixtureMoved` ne jette pas.
    await notifyFixtureMoved(resultat.annonce.ctx, resultat.annonce.from, resultat.annonce.to);
  }

  return NextResponse.json(
    resultat.updated ? serializeInterclub(resultat.updated, session.userId, admin) : { ok: true },
  );
}

// DELETE /api/interclub/{id} : créateur ou admin (supprime matchs et jeux en cascade).
//
// ⚠️ UNE RENCONTRE COMMENCÉE NE SE SUPPRIME PLUS QUE PAR UN ADMIN.
//
// La suppression est DÉFINITIVE et emporte en cascade les simples, le jeu par jeu et les
// disponibilités. Tant que ces lignes ne servaient qu'à afficher un score passé, la perte était
// regrettable ; depuis que les statistiques de joueur s'en déduisent, un seul clic efface le
// palmarès de quatre personnes — et rien ne le dit à l'écran, le total se contentant de
// diminuer.
//
// Le `PATCH` refuse de déplacer une rencontre entamée (409). Le chemin de la SUPPRESSION, plus
// destructeur, était pourtant resté le plus permissif des deux. L'admin garde la main : une
// soirée créée par erreur et marquée par erreur doit rester effaçable.
//
// ⚠️ LA GARDE EST ÉVALUÉE DANS LA TRANSACTION, pour la même raison que celle du `PATCH` : elle
// se lisait sur un état chargé avant l'écriture, et le premier point d'une soirée est saisi au
// bord du terrain pendant que quelqu'un range son calendrier. La course était étroite mais son
// prix est le plus élevé du dépôt — c'est la seule suppression irréversible de la fonction.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;
  const admin = isAdminEmail(session.email);

  // La garde des DROITS dehors, comme au `PATCH` : elle ne court pas de risque de concurrence,
  // et la laisser ici garde l'ordre 404 → 403 → 409 que le test « le 403 passe AVANT le 409 »
  // fixe depuis toujours.
  const droit = await prisma.interclub.findUnique({ where: { id }, select: { createdById: true } });
  if (!droit) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }
  if (droit.createdById !== session.userId && !admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  try {
    await serializableTransaction(async (tx) => {
      const f = await tx.interclub.findUnique({
        where: { id },
        select: { matchCount: true, matches: { select: { gamesHome: true, status: true } } },
      });
      // Déjà supprimée par quelqu'un d'autre : le résultat voulu est atteint, et un 404 ferait
      // croire à un échec. On se tait, comme le ferait un `deleteMany` qui ne trouve rien.
      if (!f) return;
      if (!admin && derivedStatus(f.matchCount, f.matches) !== "scheduled") {
        throw new HttpError(
          409,
          "Rencontre déjà commencée : ses résultats comptent dans les statistiques. " +
            "Demande à un admin de la supprimer.",
        );
      }
      await tx.interclub.delete({ where: { id } });
    }, "Suppression concurrente, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }

  interclubChanged();
  return NextResponse.json({ ok: true });
}
