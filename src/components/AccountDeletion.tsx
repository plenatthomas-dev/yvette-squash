"use client";

// Contenu de la page publique /suppression-compte : la demande elle-même, puis ce qui part et
// ce qui reste.
//
// Comme la note de confidentialité, les listes suivent les flags : on n'annonce la suppression
// que de ce qui existe, et on ne tait aucune conservation. Les deux textes doivent dire la même
// chose — en particulier sur les deux exceptions (interclub, tournois), où la note promet
// « tes données disparaissent avec ton compte ».

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeatureProvider";
import { CONTACT_EMAIL, CONTROLLER } from "@/components/PrivacyContent";
import { MODERATION_RETENTION_LABEL } from "@/lib/retention";

// undefined = on ne sait pas encore ; null = personne n'est connecté sur ce navigateur.
type Me = { displayName: string } | null | undefined;
type Step = "idle" | "confirm" | "sending" | "sent";

const MAIL_SUBJECT = "Suppression de compte — Squash de l'Yvette";

export function AccountDeletion() {
  const {
    emailLogin,
    biometry,
    directory,
    ranking,
    delegation,
    interclub,
    forum,
    tricount,
    tournament,
  } = useFeatures();
  const [me, setMe] = useState<Me>(undefined);
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);

  // La page est publique : on demande au serveur si une session existe, plutôt que de supposer.
  // Dans l'appli Android, c'est le cookie de Chrome — la même session que l'appli.
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { displayName?: string }) : null))
      .then((d) => {
        if (alive) setMe(d ? { displayName: d.displayName ?? "" } : null);
      })
      .catch(() => {
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const send = async () => {
    setStep("sending");
    setErr(null);
    try {
      const res = await fetch("/api/account/deletion-request", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Envoi impossible.");
      setStep("sent");
    } catch (e) {
      setErr((e as Error).message);
      setStep("confirm");
    }
  };

  const mailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(MAIL_SUBJECT)}`;

  return (
    <>
      <h1>Supprimer ton compte</h1>
      <p className="legal-lede">
        <strong>Squash de l&apos;Yvette</strong> (« Squash Yvette » sur Android), appli éditée par{" "}
        {CONTROLLER}. Tu peux demander la suppression de ton compte et des données qui y sont
        liées à tout moment, sans te justifier et sans avoir besoin de l&apos;appli.
      </p>

      <h2>Faire la demande</h2>
      {me === undefined ? (
        <p className="muted">Vérification de ta connexion…</p>
      ) : me && step === "sent" ? (
        <div className="notice" role="status">
          ✅ Demande envoyée. Tu recevras la confirmation de la suppression par e-mail, dans un
          mois au plus.
        </div>
      ) : me ? (
        <>
          <p>
            Compte connecté sur cet appareil : <strong>{me.displayName || "ton compte"}</strong>.
          </p>
          {step === "idle" ? (
            <div className="legal-actions">
              <button type="button" onClick={() => setStep("confirm")}>
                Demander la suppression de mon compte
              </button>
            </div>
          ) : (
            <>
              <p>
                La demande part chez l&apos;administrateur, avec ton nom et ton adresse e-mail.
                Ton compte sera supprimé avec tout ce qui est décrit plus bas.
              </p>
              <div className="legal-actions">
                <button
                  type="button"
                  className="danger"
                  disabled={step === "sending"}
                  onClick={send}
                >
                  {step === "sending" ? "Envoi…" : "Confirmer la demande"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={step === "sending"}
                  onClick={() => {
                    setErr(null);
                    setStep("idle");
                  }}
                >
                  Annuler
                </button>
              </div>
            </>
          )}
          {err && (
            <div className="notice error" role="alert">
              ⚠️ {err}
            </div>
          )}
        </>
      ) : (
        <p>
          Personne n&apos;est connecté sur ce navigateur.{" "}
          {CONTACT_EMAIL ? (
            <>Écris-nous à l&apos;adresse ci-dessous, ou connecte-toi puis reviens sur cette page.</>
          ) : (
            <>
              <Link href="/">Connecte-toi</Link>, puis reviens sur cette page.
            </>
          )}
        </p>
      )}
      {CONTACT_EMAIL && (
        <p>
          Par e-mail : <a href={mailto}>{CONTACT_EMAIL}</a>, depuis l&apos;adresse de ton compte
          si possible, en donnant le nom sous lequel tu apparais dans l&apos;appli.
        </p>
      )}
      <p className="muted">
        Dans l&apos;appli : ⚙️ Paramètres › « Supprimer mon compte » mène à cette page.
      </p>

      <h2>Ensuite</h2>
      <p>
        Un administrateur supprime le compte à la main, <strong>dans un délai d&apos;un mois au
        plus</strong> (celui que fixe le RGPD), et te le confirme par e-mail. La suppression ferme
        aussi ta session sur tous tes appareils.
      </p>
      {(tricount || tournament) && (
        <p>
          Si tu as avancé ou partagé une dépense
          {tricount ? " dans « Frais »" : ""}
          {tournament ? ", ou créé un tournoi" : ""}, ces lignes concernent aussi d&apos;autres
          membres : on les règle d&apos;abord avec toi. En attendant, ton compte est désactivé et
          plus personne ne peut s&apos;y connecter.
        </p>
      )}

      <h2>Ce qui est supprimé</h2>
      <ul>
        <li>
          Ton nom, ton adresse e-mail, ton pseudonyme
          {emailLogin ? ", ton mot de passe (haché)" : ""} et ton jeton de session ResaMania
          (chiffré)
        </li>
        <li>Tes sessions{biometry ? " et tes passkeys" : ""}</li>
        <li>
          La trace des réservations faites depuis l&apos;appli et tes présences (la réservation
          elle-même vit chez ResaMania, voir plus bas)
        </li>
        <li>Tes alertes de liste d&apos;attente, tes abonnements aux notifications et ta cloche</li>
        {directory && <li>Ta fiche dans l&apos;annuaire des membres</li>}
        {ranking && <li>Ton classement fédéral rapproché et son historique</li>}
        {delegation && <li>Les délégations de droits que tu as données ou reçues</li>}
        {interclub && <li>Tes disponibilités et tes suivis d&apos;équipe interclub</li>}
        {forum && <li>Tes messages, réactions et votes dans le fil de discussion</li>}
        {tricount && <li>Tes commentaires et tes validations dans « Frais »</li>}
      </ul>

      <h2>Ce qui est conservé</h2>
      <ul>
        {interclub && (
          <li>
            Ton nom et tes scores sur les <strong>feuilles de match interclub</strong> déjà
            jouées : un résultat sportif ne se réécrit pas. Le lien avec ton compte, lui,
            disparaît
          </li>
        )}
        {tournament && (
          <li>
            Ton nom dans le <strong>tableau des tournois</strong> que tu as joués, pour la même
            raison
          </li>
        )}
        {emailLogin && (
          <li>
            Si ton compte a été créé par une demande d&apos;inscription, la trace de la décision
            prise sur cette demande, <strong>{MODERATION_RETENTION_LABEL}</strong> au plus
            (anti-abus)
          </li>
        )}
        <li>L&apos;e-mail de ta demande, chez l&apos;administrateur qui l&apos;a traitée</li>
      </ul>

      <h2>Ce que ça ne touche pas</h2>
      <p>
        Ton compte <strong>ResaMania</strong> et les réservations qu&apos;il porte : ils sont
        gérés par le club et ResaMania, pas par cette appli. Pour les supprimer, adresse-toi au
        club.
        {ranking && (
          <>
            {" "}Ta fiche sur <strong>squashnet.fr</strong>, publiée par la fédération, non plus.
          </>
        )}
      </p>
      <p>
        Le détail de ce que l&apos;appli conserve et pourquoi :{" "}
        <Link href="/confidentialite">politique de confidentialité</Link>.
      </p>
    </>
  );
}
