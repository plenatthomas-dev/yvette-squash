"use client";

import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useFeatures } from "@/components/FeatureProvider";
import { MODERATION_RETENTION_LABEL } from "@/lib/retention";

// Responsable du traitement (art. 13 RGPD) : son identité ET ses coordonnées doivent figurer
// dans la note — le but est qu'on sache à qui l'on confie ses données, et à qui s'adresser.
// L'adresse doit rester joignable par quelqu'un qui n'a PAS de compte : une demande
// d'inscription rejetée laisse un e-mail en base, et son auteur ne peut pas se connecter pour
// utiliser « Un commentaire ? ». Le canal in-app ne suffit donc pas à lui seul.
// Boîte DÉDIÉE (pas l'adresse perso) : transmissible à un successeur sans donner accès à des
// mails privés. Surchargeable par env pour changer de boîte sans redéployer le code.
const CONTROLLER = "Thomas Plenat";
const CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_PRIVACY_CONTACT?.trim() || "squash-yvette.app@gmail.com";

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
  const { directory, ranking, tricount, tournament, delegation } = useFeatures();
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
                l'appli. Pour toute question ou demande sur tes données :{" "}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
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
                (<strong>BotID</strong>, à l'inscription). Rien n'est vendu, ni transmis à des
                tiers en dehors de ça.
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
                quelqu'un qui n'est pas membre.
              </p>
              <p>
                <strong>Combien de temps.</strong> Tes données de membre vivent
                <strong> aussi longtemps que ton compte</strong> et disparaissent avec lui.
                Les traces de modération ci-dessus : <strong>{MODERATION_RETENTION_LABEL}</strong>.
                Les données anti-abus sont éphémères (quelques minutes à 24 h), et une session
                expire d'elle-même.
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
                  (<strong>squashnet.fr</strong>, source publique) peut s'afficher à côté de
                  ton nom si tu es dans l'annuaire, et pré-remplir les têtes de série d'un
                  tournoi. On conserve aussi ton numéro de licence et ton club (vérification
                  du rapprochement) — <strong>jamais affichés</strong>. Retire-toi de
                  l'annuaire pour le masquer.
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
                ou supprimer tes données, et t'opposer à un traitement. Écris à{" "}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, ou passe par
                ⚙️ Paramètres › « Un commentaire&nbsp;? » si tu es connecté.
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
