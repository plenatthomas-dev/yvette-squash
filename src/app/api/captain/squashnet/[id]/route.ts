import { NextRequest, NextResponse } from "next/server";
import { requireCaptain, requireCaptainOf } from "@/lib/captain-access";
import { lireRapport } from "@/lib/captain-check";
import { clientIp } from "@/lib/client-ip";
import { prisma } from "@/lib/db";
import { readJsonBody } from "@/lib/http-tx";
import {
  ACTION_DETAIL,
  ACTION_FORMULAIRE,
  ACTION_RENCONTRES,
  FormulaireIlisible,
  construireEnvoi,
  ecartsApresEnvoi,
  empreinteEnvoi,
  parseDetailRencontre,
  parseFormulaireSaisie,
  parseRencontresCapitaine,
  raisonFermeture,
} from "@/lib/squashnet/captain";
import {
  AccesRefuse,
  SessionInvalide,
  ouvrirSession,
  posterAjax,
  posterFormulaire,
} from "@/lib/squashnet/session";
import { texte } from "@/lib/squashnet/html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/captain/squashnet/{id}
// { action: "preview" | "send", login, password, seen? }
//
// ENVOYER LE SCORE CHEZ LA FÉDÉRATION, AU NOM DU CAPITAINE ET SUR SON GESTE.
//
// Le score officiel se saisit dans l'espace capitaine de squashnet ; l'autre capitaine le
// confirme ensuite. Cette route fait la saisie à la place du recopiage à la main, en DEUX TEMPS,
// comme l'import du calendrier :
//
//  * `preview` se connecte, lit le formulaire, construit l'envoi et le MONTRE — rien n'est écrit ;
//  * `send` refait la même construction, refuse si elle diffère de ce qui a été montré (`seen`),
//    envoie, puis RELIT le détail chez squashnet et le compare à ce qui est parti.
//
// ⚠️ LES IDENTIFIANTS SQUASHNET NE SONT NI STOCKÉS NI JOURNALISÉS. Ils transitent dans le corps
// de la requête (jamais l'URL), servent à UNE connexion, et meurent avec elle — la session
// squashnet aussi (cf. `squashnet/session.ts`). Aucune réponse ne les répète. Le navigateur du
// capitaine peut les mémoriser dans son propre gestionnaire de mots de passe : c'est le seul
// endroit où ils vivent.
//
// CE QUI PART EST LE RAPPORT DE VÉRIFICATION, pas les simples relus en base : c'est ce que le
// capitaine a eu sous les yeux. D'où le refus si le relevé a bougé APRÈS la vérification.

/** Les échecs d'accès squashnet, plafonnés pour ne pas faire verrouiller le compte fédéral. */
const FENETRE_MS = 15 * 60_000;
const MAX_ECHECS = 3;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // La garde d'abord, la base ensuite (même raison que `/api/captain/check`).
  const porte = await requireCaptain(req);
  if (!porte.ok) return porte.response;

  const body = await readJsonBody(req);
  const action = body.action;
  const login = typeof body.login === "string" ? body.login.trim() : "";
  const motDePasse = typeof body.password === "string" ? body.password : "";
  if (action !== "preview" && action !== "send") return json({ error: "Action inconnue" }, 400);
  if (!login || !motDePasse || login.length > 200 || motDePasse.length > 200) {
    return json({ error: "Identifiant et mot de passe squashnet requis." }, 400);
  }

  const fixture = await prisma.interclub.findUnique({
    where: { id },
    select: {
      teamId: true,
      snTieId: true,
      team: { select: { snTeamId: true, snRoundId: true } },
      official: { select: { checkJson: true } },
      matches: { select: { status: true, updatedAt: true } },
    },
  });
  if (!fixture) return json({ error: "Rencontre introuvable" }, 404);
  const access = await requireCaptainOf(req, fixture.teamId);
  if (!access.ok) return access.response;

  // --- Ce qu'il faut AVANT de parler à squashnet ------------------------------
  const rapport = lireRapport(fixture.official?.checkJson ?? null);
  if (!rapport) return json({ error: "Vérifie d'abord la rencontre." }, 409);
  if (fixture.matches.some((m) => m.status !== "done")) {
    return json({ error: "Tous les simples doivent être terminés." }, 409);
  }
  const verifieLe = new Date(rapport.checkedAt).getTime();
  if (fixture.matches.some((m) => m.updatedAt.getTime() > verifieLe)) {
    return json(
      { error: "Le relevé a changé depuis la vérification : revérifie la rencontre avant d'envoyer." },
      409,
    );
  }
  const snTeamId = fixture.team.snTeamId;
  if (!snTeamId || !fixture.snTieId) {
    return json(
      { error: "Identifiant fédéral de la rencontre inconnu : relance « Vérifier la rencontre »." },
      409,
    );
  }

  // --- Le plafond d'échecs ----------------------------------------------------
  //
  // Dans `LoginAttempt`, sous des clés PRÉFIXÉES : la connexion à l'appli compte ses échecs par
  // IP brute et par e-mail, et un mot de passe squashnet mal tapé trois fois ne doit pas
  // bloquer l'accès à l'appli depuis le même téléphone.
  const ip = `squashnet:${clientIp(req)}`;
  const identifier = `squashnet:${porte.session.userId}`;
  const depuis = new Date(Date.now() - FENETRE_MS);
  const echecs = await prisma.loginAttempt.count({ where: { identifier, createdAt: { gte: depuis } } });
  if (echecs >= MAX_ECHECS) {
    return json(
      { error: "Trop de refus de squashnet — réessaie dans un quart d'heure, ou saisis à la main." },
      429,
    );
  }

  try {
    const session = await ouvrirSession(login, motDePasse);
    const html = await posterAjax(session, { ic_a: ACTION_FORMULAIRE, tieid: fixture.snTieId });

    if (!/id=["']frmResults["']/.test(html)) {
      // Pas de formulaire : la liste des rencontres dit pourquoi (déjà saisie, pas encore
      // ouverte, fenêtre de 5 jours passée).
      let raison = raisonFermeture(undefined);
      if (fixture.team.snRoundId) {
        const liste = await posterAjax(session, {
          ic_a: ACTION_RENCONTRES,
          teamid: snTeamId,
          roundid: fixture.team.snRoundId,
        });
        raison = raisonFermeture(parseRencontresCapitaine(liste).find((l) => l.tieid === fixture.snTieId));
      }
      return json({ error: raison }, 409);
    }

    const construction = construireEnvoi(parseFormulaireSaisie(html), rapport, snTeamId);
    if (!construction.ok) {
      return json(
        { error: "L'envoi n'est pas possible tel quel.", problemes: construction.problemes },
        409,
      );
    }
    const { envoi } = construction;
    const seen = empreinteEnvoi(envoi.champs);

    if (action === "preview") return json({ lignes: envoi.lignes, seen });

    // ⚠️ L'ENVOI N'EXISTE QU'EN PRODUCTION. Recette et les prévisualisations tournent sur la
    // base de dev, mais squashnet, lui, est le vrai : un essai y enverrait des scores d'essai
    // à la vraie fédération, au nom d'un vrai capitaine. L'aperçu, qui n'écrit rien, reste
    // ouvert partout — c'est lui qu'on essaie.
    if (process.env.VERCEL_ENV !== "production") {
      return json(
        {
          error:
            "Ici, seul l'aperçu est possible : l'envoi ne part que depuis l'appli de production, pour ne jamais transmettre de données d'essai à la fédération.",
        },
        409,
      );
    }

    if (body.seen !== seen) {
      return json(
        { error: "Ce qui partirait a changé depuis l'aperçu : prépare l'envoi à nouveau." },
        409,
      );
    }

    const reponse = await posterFormulaire(session, envoi.champs);
    const detail = parseDetailRencontre(
      await posterAjax(session, { ic_a: ACTION_DETAIL, tieid: fixture.snTieId }),
    );
    const ecarts = ecartsApresEnvoi(envoi, detail);
    if (ecarts.length > 0) {
      // Le texte de la réponse dit souvent pourquoi (« Joueur trop fort »…). Tronqué : c'est
      // un indice pour le capitaine, pas une page à afficher.
      return json(
        {
          error: "squashnet n'affiche pas ce qui a été envoyé — vérifie sur squashnet.",
          problemes: ecarts,
          reponse: texte(reponse).slice(0, 300) || null,
        },
        502,
      );
    }
    return json({ ok: true, lignes: envoi.lignes, saisiePar: detail.saisiePar });
  } catch (e) {
    if (e instanceof AccesRefuse) {
      await prisma.loginAttempt.create({ data: { ip, identifier } }).catch(() => {});
      // PAS 401 : le client lit 401 comme « ta session APPLI a expiré » et déconnecte.
      return json(
        {
          error:
            "squashnet refuse l'accès : identifiant ou mot de passe incorrect, ou ce compte n'est pas capitaine de cette équipe.",
        },
        403,
      );
    }
    if (e instanceof SessionInvalide) {
      return json({ error: "La session squashnet a expiré en cours de route : réessaie." }, 502);
    }
    if (e instanceof FormulaireIlisible) {
      return json(
        { error: "Le formulaire squashnet a changé et ne se lit plus : saisis à la main pour cette fois." },
        502,
      );
    }
    // Le message d'origine N'EST PAS repris : une erreur réseau peut citer une URL, et rien
    // ici ne doit pouvoir faire ressortir quoi que ce soit de la requête du capitaine.
    return json({ error: "squashnet ne répond pas. Réessaie dans un moment." }, 502);
  }
}
