"use client";

// Le TABLEAU DE BORD de /admin (indicateurs, santé des crons, erreurs récentes), sorti de
// admin/page.tsx (audit 2026-10, point 28 : la page dépassait 2 800 lignes). Purement
// présentationnel : il affiche ce que /api/admin/dashboard a rendu.

import { bookingOriginHint } from "@/lib/booking-origin";
import { NOTIF_STATE_WINDOW_DAYS, platformBreakdown, type NotifSummary } from "@/lib/notif-state";

type CronRun = { name: string; lastRunAt: string | null; ok: boolean; info: string | null; late?: boolean };

export type Dashboard = {
  members: number;
  disabledMembers: number;
  activeSessions: number;
  resaSessions: number;
  recentLogins: number;
  activeAlerts: number;
  pendingRequests: number;
  blockedEmails: number;
  // Origine des résas actives sur 30 j : via l'appli vs détectées directement sur ResaMania.
  bookingsApp: number;
  bookingsResa: number;
  // false ⇒ la détection « hors appli » est coupée, donc bookingsResa vaut 0 par construction.
  externalDetection: boolean;
  // Absent tant que le serveur déployé ne le calcule pas encore (déploiement en cours).
  notifs?: NotifSummary;
  crons: CronRun[];
  errors?: { createdAt: string; source: string; message: string; digest: string | null; path: string | null }[];
};

export default function AdminDashboard({ dash }: { dash: Dashboard }) {
  return (
        <section className="adm-carte" style={{ marginBottom: 18 }}>
          {/* HORS GROUPE, et en tête : on le lit, on n'y touche pas. Lui donner un filet de
              portée serait mentir — il ne règle rien. */}
          <h2 className="adm-carte-titre">📊 Tableau de bord</h2>
          <div className="adm-stats">
            <Stat label="Membres" value={dash.members} hint={dash.disabledMembers ? `${dash.disabledMembers} désactivé(s)` : undefined} />
            <Stat label="Actifs (30 j)" value={dash.recentLogins} />
            <Stat label="Sessions" value={dash.activeSessions} hint={`${dash.resaSessions} ResaMania`} />
            <Stat label="Alertes terrain" value={dash.activeAlerts} />
            <Stat label="En attente" value={dash.pendingRequests} />
            <Stat label="Bloqués" value={dash.blockedEmails} />
            <Stat
              label="Résas (30 j)"
              value={dash.bookingsApp + dash.bookingsResa}
              hint={bookingOriginHint(dash)}
            />
          </div>

          {dash.notifs && <NotifStats n={dash.notifs} members={dash.members - dash.disabledMembers} />}

          {/* Santé des crons */}
          <div style={{ marginTop: 10 }}>
            {dash.crons.length === 0 ? (
              <p className="muted tiny">Aucun passage de cron enregistré pour l'instant.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {dash.crons.map((c) => (
                  <li key={c.name} className="tiny" style={{ display: "flex", gap: 6 }}>
                    <span title={c.late ? "en retard" : c.ok ? "OK" : "problème"}>
                      {c.late ? "🟠" : c.ok ? "🟢" : "🔴"}
                    </span>
                    <strong>{c.name}</strong>
                    <span className="muted">
                      {c.lastRunAt
                        ? new Date(c.lastRunAt).toLocaleString("fr-FR", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "jamais"}
                      {c.late ? " · EN RETARD" : ""}
                      {c.info ? ` · ${c.info}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Erreurs non rattrapées (cf. lib/error-report) : 30 jours de mémoire, là où les
              logs du plan Hobby n'en gardent qu'une heure. */}
          {dash.errors && dash.errors.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="tiny">
                ⚠️ {dash.errors.length} erreur{dash.errors.length > 1 ? "s" : ""} récente
                {dash.errors.length > 1 ? "s" : ""}
              </summary>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {dash.errors.map((e, i) => (
                  <li key={`${e.createdAt}-${i}`} className="tiny" style={{ wordBreak: "break-word" }}>
                    <span className="muted">
                      {new Date(e.createdAt).toLocaleString("fr-FR", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      · {e.source}
                      {e.path ? ` · ${e.path}` : ""}
                    </span>{" "}
                    {e.message}
                    {e.digest ? <span className="muted"> ({e.digest})</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
  );
}

function NotifStats({ n, members }: { n: NotifSummary; members: number }) {
  return (
    <>
      <hr className="adm-sep" />
      <h3 className="adm-carte-titre">🔔 Notifications</h3>
      {n.members === 0 ? (
        <p className="muted tiny">
          Aucun appareil relevé pour l&apos;instant : les chiffres arrivent à mesure que les membres
          ouvrent l&apos;appli.
        </p>
      ) : (
        <>
          <p className="muted tiny">
            {n.members} membre{n.members > 1 ? "s" : ""} relevé{n.members > 1 ? "s" : ""} sur{" "}
            {members} ({n.devices} appareil{n.devices > 1 ? "s" : ""} ouvert
            {n.devices > 1 ? "s" : ""} ces {NOTIF_STATE_WINDOW_DAYS} derniers jours).
          </p>
          <div className="adm-stats">
            <Stat label="Les reçoivent" value={n.byMember.receiving} />
            <Stat
              label="Bloquées"
              value={n.byMember.denied}
              hint={platformBreakdown(n.deniedByPlatform) || undefined}
            />
            <Stat label="Jamais demandé" value={n.byMember.notAsked} />
            <Stat label="Coupées" value={n.byMember.off} hint="« Ne plus recevoir »" />
            <Stat
              label="Sans support"
              value={n.byMember.unsupported}
              hint={platformBreakdown(n.unsupportedByPlatform) || undefined}
            />
          </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="adm-stat">
      <div className="adm-stat-valeur">{value}</div>
      <div className="tiny">{label}</div>
      {hint && <div className="muted tiny">{hint}</div>}
    </div>
  );
}
