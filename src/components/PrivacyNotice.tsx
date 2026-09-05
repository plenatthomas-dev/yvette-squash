"use client";

import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useFeatures } from "@/components/FeatureProvider";
import {
  MODERATION_RETENTION_LABEL,
  SNAPSHOT_RETENTION_LABEL,
  FORUM_RETENTION_LABEL,
} from "@/lib/retention";

// Responsable du traitement (art. 13 RGPD) : son identité ET ses coordonnées doivent figurer
// dans la note — le but est qu'on sache à qui l'on confie ses données, et à qui s'adresser.
// L'adresse doit rester joignable par quelqu'un qui n'a PAS de compte : une demande
// d'inscription rejetée laisse un e-mail en base (12 mois), et son auteur ne peut pas se
// connecter pour utiliser « Un commentaire ? ». Le canal in-app ne suffit donc pas à lui seul.
//
// L'adresse vit UNIQUEMENT dans la configuration : boîte dédiée (jamais l'adresse perso),
// transmissible à un successeur sans donner accès à des mails privés, et changeable sans
// toucher au code. Une seule source de vérité.
//
// ⚠️ NEXT_PUBLIC_* est inliné AU BUILD : la variable doit être définie sur CHAQUE environnement
// (Production ET Preview), et un changement n'est pris en compte qu'au redéploiement. Si elle
// manque, la note reste correcte sur tout le reste mais ne peut proposer que le canal in-app —
// inaccessible, justement, à qui n'a pas de compte.
const CONTROLLER = "Thomas Plenat";
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_PRIVACY_CONTACT?.trim() ?? "";

// Version affichée à côté de la note, sous la forme courte « v2.0 » (MAJEUR.MINEUR, calculé
// depuis package.json — cf. next.config.mjs). Elle sert à UNE chose : qu'un membre qui signale
// un souci puisse dire où il en est, sans avoir à décrire son navigateur. D'où le pied de page,
// présent sur la connexion comme sur l'appli, et le ton volontairement muet (gris, petit) —
// c'est une information de dépannage, pas un élément d'interface.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

// Identifiant du build qui a produit CETTE page — inliné à la compilation, donc figé dans le
// JS que le navigateur exécute réellement. C'est la donnée qui manquait pour départager
// « le correctif n'est pas bon » de « cet onglet tourne encore sur l'ancien build » :
// /api/version répond, lui, l'identifiant du SERVEUR, et les deux diffèrent précisément dans
// le cas qu'on cherche à diagnostiquer. Affiché dans l'infobulle de la version, pas à l'écran.
const BUILD_ID = (process.env.NEXT_PUBLIC_BUILD_ID ?? "").slice(0, 7);

// Icône « information » (cercle + i) — ouvre la note de confidentialité.
export function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </svg>
  );
}

// Pied de page : petite note « Confidentialité & données » (obligation d'information RGPD).
// Placée en bas de page (convention pour ce type de mention), sur l'écran de connexion
// comme sur l'appli. La modale réutilise le style .modal existant.
export function PrivacyNotice() {
  const [open, setOpen] = useState(false);
  const { directory, ranking, tricount, tournament, delegation, interclub, forum } =
    useFeatures();
  return (
    <footer className="app-footer">
      <button
        type="button"
        className="footer-info"
        onClick={() => setOpen(true)}
        aria-label="Confidentialité et données"
        title="Confidentialité et données"
      >
        <InfoIcon />
        <span>Confidentialité &amp; données</span>
      </button>
      {APP_VERSION && (
        <span
          className="footer-version"
          title={
            `Version ${APP_VERSION} de l'application` +
            (BUILD_ID ? ` · build ${BUILD_ID} (celui de cette page)` : "")
          }
        >
          v{APP_VERSION}
        </span>
      )}
      {open && (
        <Dialog onClose={() => setOpen(false)} label="Confidentialité et données" className="privacy">
            <h3>Confidentialité &amp; données</h3>
            <div className="privacy-body">
              <p>
                Application indépendante, <strong>non affiliée à ResaMania / Stadline ni au
                club</strong> : elle facilite la réservation des terrains de squash du
                Complexe de Bures via ton compte ResaMania.
              </p>
              <p>
                <strong>Qui est responsable.</strong> {CONTROLLER}, qui développe et exploite
                l'appli.{" "}
                {CONTACT_EMAIL ? (
                  <>
                    Pour toute question ou demande sur tes données :{" "}
                    <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
                  </>
                ) : (
                  <>Contact : ⚙️ Paramètres › « Un commentaire&nbsp;? », une fois connecté.</>
                )}
              </p>
              <p>
                <strong>Ce qu'on garde.</strong> Ton nom (fourni par ResaMania), ton e-mail,
                ton éventuel pseudonyme, les réservations faites ici, ta date de dernière
                connexion et ton IP de connexion (anti-abus). Ton mot de passe ResaMania n'est
                <strong> jamais conservé</strong> — seulement un jeton de session
                <strong> chiffré</strong> (AES-256-GCM). Si tu utilises la connexion par e-mail,
                ton mot de passe est conservé <strong>haché</strong> (scrypt), jamais en clair.
              </p>
              <p>
                <strong>Ce qu'on en fait, et à quel titre.</strong> Te connecter et gérer les
                réservations (<em>exécution du service que tu demandes</em>) ; protéger l'appli
                du spam et des abus, et faire vivre l'entraide entre membres
                (<em>intérêt légitime</em>) ; les notifications reposent sur
                <em> ton consentement</em>, retirable à tout moment depuis ton navigateur.
              </p>
              <p>
                <strong>Qui d'autre voit passer tes données.</strong> Hébergement en
                <strong> Union européenne</strong> (Vercel, base Neon). L'appli s'appuie aussi
                sur <strong>ResaMania</strong> (que tu utilises déjà), <strong>Brevo</strong>
                {" "}(envoi des e-mails — il reçoit ton nom et ton adresse quand tu nous écris),
                et sur les outils de Vercel : mesure d'audience
                (<strong>Analytics</strong>, sans cookie ni profilage) et détection de robots
                (<strong>BotID</strong>, à l'inscription).{" "}
                {forum && (
                  <>
                    Le fil de discussion passe par <strong>Pusher</strong> (Irlande, Union
                    européenne) pour l&apos;affichage instantané&nbsp;: il achemine les messages
                    vers les membres connectés, et sait qui l&apos;est.{" "}
                  </>
                )}
                Rien n'est vendu, ni transmis à des tiers en dehors de ça.
              </p>
              <p>
                <strong>Administrateurs.</strong> Un ou deux membres ont un accès
                d'administration : ils voient la liste des comptes (nom, e-mail, dates de
                création et de dernière connexion), valident les demandes d'inscription et
                peuvent désactiver ou supprimer un compte. Ils peuvent aussi publier une
                annonce à tous.
              </p>
              <p>
                <strong>Demandes d'inscription.</strong> L'accès se fait sur validation : ta
                demande enregistre ton e-mail et le nom que tu choisis. La décision (acceptée
                ou refusée) est <strong>journalisée {MODERATION_RETENTION_LABEL}</strong>, y
                compris en cas de refus, ainsi que les adresses bloquées pour empêcher une
                réinscription abusive. C'est le seul endroit où l'appli garde une donnée sur
                quelqu'un qui n'est pas membre
                {tournament || interclub
                  ? ", en dehors des noms que des membres saisissent eux-mêmes (voir plus bas)"
                  : ""}
                .
              </p>
              <p>
                <strong>Combien de temps.</strong> Tes données de membre vivent
                <strong> aussi longtemps que ton compte</strong> et disparaissent avec lui.
                Les traces de modération ci-dessus : <strong>{MODERATION_RETENTION_LABEL}</strong>.
                {forum && (
                  <>
                    {" "}Les messages du fil de discussion :{" "}
                    <strong>{FORUM_RETENTION_LABEL}</strong>, puis effacés automatiquement.
                  </>
                )}
                Le planning du club est mis en cache (pour l'afficher aux comptes sans accès
                ResaMania) et effacé <strong>{SNAPSHOT_RETENTION_LABEL}</strong> après le jour
                concerné. Les données anti-abus sont éphémères (quelques minutes à 24 h), et une
                session expire d'elle-même.
              </p>
              {directory && (
                <p>
                  <strong>Annuaire des membres.</strong> Ton nom (ou pseudonyme) est visible
                  des membres connectés — <strong>rien d'autre</strong> (ni e-mail, ni
                  réservations). Retrait à tout moment : ⚙️ Paramètres › « Annuaire des
                  membres ».
                </p>
              )}
              {ranking && (
                <p>
                  <strong>Classement fédéral.</strong> Ton classement FFSquash
                  (<strong>squashnet.fr</strong>, source publique) peut s&apos;afficher à côté de
                  ton nom si tu es dans l&apos;annuaire, et pré-remplir les têtes de série d&apos;un
                  tournoi. On conserve aussi ton numéro de licence et ton club (vérification
                  du rapprochement) — <strong>jamais affichés</strong>. Retire-toi de
                  l&apos;annuaire pour le masquer.
                  {interclub && (
                    <>
                      {" "}
                      <strong>Une exception</strong>&nbsp;: si un administrateur t&apos;a
                      rattaché à une <strong>équipe interclub</strong>, ton classement et ton
                      rang continuent d&apos;être rapprochés même hors annuaire — la compétition
                      impose de composer les simples dans l&apos;ordre du classement, et sans lui
                      tu ne pourrais être aligné nulle part. Il reste alors visible des seuls
                      membres qui composent une rencontre, pas dans l&apos;annuaire.
                    </>
                  )}
                </p>
              )}
              <p>
                <strong>Liste d'attente &amp; notifications.</strong> Sur un créneau complet,
                on enregistre le créneau visé et, si tu l'autorises, un abonnement aux
                notifications de ton navigateur — il sert aux alertes « terrain libéré » et aux
                annonces de l'asso. Les membres voient le
                <strong> nombre d'inscrits</strong> et <strong>ta position</strong> —
                <strong> jamais les noms</strong>.
              </p>
              {tricount && (
                <p>
                  <strong>Partage de frais (« Frais »).</strong> Dépenses, remboursements et
                  messages y sont visibles de <strong>tous les membres connectés</strong>,
                  avec le <strong>nom réel</strong> (jamais le pseudonyme) — donc qui doit
                  combien à qui. N'y saisis que ce que tu acceptes de partager.
                </p>
              )}
              {tournament && (
                <p>
                  <strong>Tournois.</strong> Participants (dont <strong>prénoms d'invités hors
                  asso</strong>), matchs et scores sont visibles de <strong>tous les membres
                  connectés</strong>. N'ajoute un invité qu'avec son accord.
                </p>
              )}
              {interclub && (
                <>
                <p>
                  <strong>Interclub.</strong> Les rencontres par équipes enregistrent qui joue,
                  contre qui, le score jeu par jeu, la date et qui tient le marquage — visibles
                  de <strong>tous les membres connectés</strong>. Deux noms de personnes sans
                  compte y figurent : ceux des <strong>adversaires</strong>, saisis à la main, et
                  ceux des <strong>joueurs de l&apos;équipe qui n&apos;ont pas l&apos;appli</strong>,
                  inscrits par un administrateur — n&apos;y porte que le nom sous lequel la personne
                  est déjà annoncée en championnat. C&apos;est aussi un administrateur qui décide de
                  l&apos;appartenance à une équipe.
                </p>
                <p>
                  <strong>Interclub — le classement des joueurs sans compte.</strong> Pour ces
                  joueurs-là, l&apos;appli recherche le <strong>classement fédéral</strong> publié
                  par <strong>squashnet.fr</strong> à partir du nom inscrit, et en conserve le
                  classement, le rang, le numéro de licence et le club (vérification du
                  rapprochement). C&apos;est nécessaire pour composer une rencontre&nbsp;: la
                  compétition impose l&apos;ordre du classement, et ces données sont <em>déjà
                  publiques</em> côté fédération. Le numéro de licence et le club ne sont
                  <strong> jamais affichés</strong>, et tout disparaît dès qu&apos;un
                  administrateur retire la personne du roster.
                </p>
                <p>
                  <strong>Interclub — ces joueurs figurent aussi dans l&apos;annuaire.</strong>{" "}
                  {directory ? (
                    <>
                      Leur nom, leur équipe et leur classement y sont visibles des{" "}
                      <strong>membres connectés</strong>, au même titre que ceux d&apos;un membre
                      inscrit — sans quoi l&apos;annuaire donnerait une photo fausse de
                      l&apos;effectif du club.
                    </>
                  ) : (
                    <>
                      Leur nom, leur équipe et leur classement y seront visibles des{" "}
                      <strong>membres connectés</strong> quand l&apos;annuaire sera activé.
                    </>
                  )}{" "}
                  Ils n&apos;y ont en revanche <strong>aucun compte</strong>&nbsp;: on ne peut ni
                  leur déléguer de droits, ni les inscrire à un tournoi, ni leur envoyer quoi que
                  ce soit. N&apos;inscris quelqu&apos;un qu&apos;avec son accord — un
                  administrateur le retire à sa demande.
                </p>
                <p>
                  <strong>Interclub &mdash; calendrier et disponibilités.</strong> Le calendrier
                  du championnat est récupéré sur <strong>squashnet.fr</strong> (source publique)
                  et n&apos;enregistre rien sur toi. Ta réponse à un match, elle, en dit
                  quelque chose&nbsp;: ta disponibilité et le commentaire libre que tu peux y
                  joindre sont visibles de <strong>toute ton équipe</strong> — c&apos;est
                  volontaire, voir qu&apos;il manque du monde est précisément ce qui fait
                  répondre le suivant. Et <strong>un coéquipier peut consigner ta réponse à ta
                  place</strong>, pour les joueurs qui n&apos;ont pas l&apos;appli ou ne
                  reçoivent pas les notifications&nbsp;: son nom s&apos;affiche alors à côté de
                  la réponse, et tu peux toujours la corriger toi-même. Le capitaine d&apos;une
                  équipe est désigné par un administrateur&nbsp;; il reçoit le récapitulatif des
                  disponibilités, et rien de plus que les autres.
                </p>
                <p>
                  <strong>Interclub — ce qui reste après.</strong> Le nom du joueur demeure
                  attaché à la feuille de match <strong>même si son compte est supprimé</strong> ou
                  s&apos;il quitte l&apos;équipe : un résultat sportif ne se réécrit pas après coup.
                  C&apos;est la <strong>seule exception</strong> au « tes données disparaissent avec
                  ton compte » ci-dessus, et elle ne porte que sur ce nom et ces scores. Le déroulé
                  point par point d&apos;un match, lui, ne quitte jamais le navigateur de celui qui
                  marque — seuls les scores de jeux sont enregistrés. Le suivi d&apos;une équipe par
                  notifications est <em>facultatif</em>, se règle en trois niveaux et se retire à
                  tout moment depuis l&apos;onglet Interclub.
                </p>
                </>
              )}
              {forum && (
                <p>
                  <strong>Le fil de discussion.</strong> Ce que tu y écris est visible de{" "}
                  <strong>tous les membres connectés</strong> — c&apos;est un fil unique, il
                  n&apos;y a pas de conversation privée dans l&apos;appli. Ton{" "}
                  <strong>nom d&apos;affichage</strong> accompagne chaque message, jamais ton
                  pseudo ni ton adresse. Tu peux <strong>supprimer les tiens</strong> à tout
                  moment&nbsp;; un administrateur peut supprimer <strong>n&apos;importe
                  lequel</strong>, parce qu&apos;un fil lu par tout le club a besoin de
                  quelqu&apos;un pour retirer ce qui n&apos;a rien à y faire. Tant que le fil est
                  ouvert devant toi, les autres membres présents{" "}
                  <strong>voient que tu es en ligne et que tu es en train d&apos;écrire</strong>
                  &nbsp;; cela ne laisse aucune trace une fois l&apos;onglet fermé. Les messages
                  sont conservés <strong>{FORUM_RETENTION_LABEL}</strong>, puis effacés. Les
                  notifications du fil se coupent depuis le fil lui-même, et tout ce que tu y as
                  écrit disparaît avec ton compte.
                </p>
              )}
              {delegation && (
                <p>
                  <strong>Délégation de droits.</strong> Si tu délègues tes droits
                  (⚙️ Paramètres), les membres choisis peuvent réserver/annuler
                  <strong> en ton nom</strong> pendant la durée fixée ; ils en sont notifiés,
                  la réservation reste sur ton compte et l'appli enregistre <strong>qui
                  délègue à qui et qui a agi</strong> (traçabilité, non publique).
                  Révocable à tout moment.
                </p>
              )}
              <p>
                <strong>Tes droits.</strong> Tu peux demander à consulter, corriger, récupérer
                ou supprimer tes données, et t'opposer à un traitement.{" "}
                {CONTACT_EMAIL ? (
                  <>
                    Écris à <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, ou passe
                    par ⚙️ Paramètres › « Un commentaire&nbsp;? » si tu es connecté.
                  </>
                ) : (
                  <>Une fois connecté, écris-nous via ⚙️ Paramètres › « Un commentaire&nbsp;? ».</>
                )}{" "}
                La déconnexion efface déjà ta session. Si une réponse ne te convient pas, tu
                peux saisir la <strong>CNIL</strong> (<a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer">cnil.fr</a>).
              </p>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}
    </footer>
  );
}
