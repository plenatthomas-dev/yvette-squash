"use client";

import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useFeatures } from "@/components/FeatureProvider";

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
                <strong>Ce qu'on garde.</strong> Ton nom (fourni par ResaMania), ton e-mail,
                ton éventuel pseudonyme, les réservations faites ici et ton IP de connexion
                (anti-abus). Ton mot de passe ResaMania n'est <strong>jamais conservé</strong> —
                seulement un jeton de session <strong>chiffré</strong> (AES-256-GCM).
              </p>
              <p>
                <strong>Ce qu'on en fait.</strong> Te connecter, gérer les réservations,
                protéger le service. Rien n'est revendu ni transmis à des tiers (hormis
                ResaMania, que tu utilises déjà). Hébergement en <strong>Union
                européenne</strong> (Vercel, base Neon).
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
                  tournoi. Retire-toi de l'annuaire pour le masquer.
                </p>
              )}
              <p>
                <strong>Liste d'attente &amp; notifications.</strong> Sur un créneau complet,
                on enregistre le créneau visé et, si tu l'autorises, un abonnement aux
                notifications de ton navigateur. Les membres voient le
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
                <strong>Tes droits.</strong> Consultation ou suppression de tes données à
                tout moment : une fois connecté, écris-nous via ⚙️ Paramètres › « Un
                commentaire&nbsp;? ». La déconnexion efface déjà ta session.
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
