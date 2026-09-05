"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import { EmptyState, Skeleton } from "@/components/Placeholders";
import { MAX_FORUM_LEN, forumLength } from "@/lib/forum";

// LE FIL DE DISCUSSION DU CLUB.
//
// Trois canaux amènent un message à l'écran, du plus rapide au plus sûr — et c'est
// volontairement redondant, parce que chacun a un trou que les autres bouchent :
//
//   1. LE COURTIER (Pusher). ~100 ms, quand l'appli est ouverte et la WebSocket vivante.
//      Trou : clés absentes, quota, panne, réseau capricieux.
//   2. `push-received`. Le service worker prévient déjà tous les onglets à chaque push
//      (public/sw.js) et la cloche s'en sert. Trou : le membre a refusé les notifications.
//   3. `onForeground`. Au retour sur l'appli. Trou : aucun, mais il faut revenir.
//
// Aucun `setInterval` : PRODUCT.md proscrit le polling, chaque réveil de Neon se paie.
//
// LE FIL DOIT MARCHER SANS LE COURTIER. Clé absente en développement, 503 en production tant
// que la fonction est en essai : la frappe et la présence disparaissent alors en silence, les
// messages continuent d'arriver par les canaux 2 et 3. Aucun écran d'erreur pour un service
// d'agrément — c'est la règle qui gouverne tout le code de connexion ci-dessous.

export type ForumMessage = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  canDelete: boolean;
};

const PAGE = 30;
/** Une frappe au plus toutes les 3 s : sans ce frein, la saisie ferait dix fois le volume des messages. */
const TYPING_EVERY_MS = 3_000;
/** Au-delà, on considère que la personne a cessé d'écrire (elle a pu fermer l'onglet). */
const TYPING_FORGET_MS = 5_000;

const horodatage = (iso: string): string => {
  const d = new Date(iso);
  const auj = new Date();
  const memeJour =
    d.getDate() === auj.getDate() &&
    d.getMonth() === auj.getMonth() &&
    d.getFullYear() === auj.getFullYear();
  const heure = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (memeJour) return heure;
  return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${heure}`;
};

/** Fusionne une arrivée dans la liste en DÉDUPLIQUANT par id, et en gardant l'ordre du temps.
 *
 *  La dédup n'est pas une précaution de style : son propre message revient par le courtier
 *  après avoir déjà été inséré par la réponse du POST. Sans elle, on se voit parler double. */
function fusionner(actuels: ForumMessage[], arrivees: ForumMessage[]): ForumMessage[] {
  if (arrivees.length === 0) return actuels;
  const par = new Map(actuels.map((m) => [m.id, m]));
  for (const m of arrivees) par.set(m.id, { ...(par.get(m.id) ?? m), ...m });
  return [...par.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export default function Forum({
  toast,
  onExpired,
}: {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [messages, setMessages] = useState<ForumMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [erreur, setErreur] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [envoi, setEnvoi] = useState(false);
  /** Qui est connecté au fil, hors soi — vient de la présence du canal, jamais de la base. */
  const [presents, setPresents] = useState<string[]>([]);
  /** Qui tape en ce moment, avec l'instant du dernier signal (pour l'oubli au bout de 5 s). */
  const [frappe, setFrappe] = useState<Record<string, number>>({});
  /** Notifications du fil coupées ? OPT-OUT : `false` par défaut, sinon le fil ne vit pas. */
  const [muted, setMuted] = useState(false);

  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** Le dernier message connu : c'est l'ancre du rattrapage après une coupure. */
  const dernierRef = useRef<string | null>(null);
  /** Mon nom d'affichage, tel que la présence le connaît — c'est lui qu'on signe en tapant. */
  const monNomRef = useRef<string>("");
  const finRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const saisieRef = useRef<HTMLTextAreaElement | null>(null);

  const charge = useCallback(
    async (n: number, mode: "page" | "rattrapage" = "page") => {
      try {
        const ancre = dernierRef.current;
        const qs =
          mode === "rattrapage" && ancre
            ? `?since=${encodeURIComponent(ancre)}`
            : `?limit=${n}`;
        const res = await fetch(`/api/forum${qs}`);
        if (onExpiredRef.current(res.status)) return;
        const data = await readOk<{
          messages: ForumMessage[];
          hasMore?: boolean;
          muted?: boolean;
        }>(res);
        if (typeof data.muted === "boolean") setMuted(data.muted);
        setErreur(null);
        setMessages((actuels) =>
          mode === "rattrapage" ? fusionner(actuels ?? [], data.messages) : data.messages,
        );
        if (mode === "page") setHasMore(Boolean(data.hasMore));
      } catch {
        // Le silence serait indiscernable d'un fil vide — le pire des deux, parce qu'il est
        // crédible. On ne l'affiche que si on n'a rien à montrer par ailleurs.
        setErreur("Discussion indisponible pour le moment.");
        setMessages((actuels) => actuels ?? []);
      }
    },
    [],
  );

  useEffect(() => {
    void charge(limit);
  }, [charge, limit]);

  // Le dernier id connu suit la liste, pour que le rattrapage reparte du bon endroit.
  useEffect(() => {
    if (messages && messages.length > 0) dernierRef.current = messages[messages.length - 1].id;
  }, [messages]);

  // CANAL 3 — retour au premier plan. Throttlé comme le planning : deux reprises de focus
  // rapprochées ne doivent pas payer deux requêtes.
  useEffect(() => onForeground(() => void charge(limit, "rattrapage"), 15_000), [charge, limit]);

  // CANAL 2 — le service worker prévient déjà tous les onglets à chaque push reçu. On filtre
  // sur notre tag pour ne pas recharger le fil quand c'est une alerte de créneau qui arrive.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "push-received" && e.data?.tag === "forum") {
        void charge(limit, "rattrapage");
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [charge, limit]);

  // CANAL 1 — le courtier. Tout ce bloc est facultatif par construction : la moindre absence
  // (clé, module, autorisation) le fait renoncer sans un mot.
  const pusherRef = useRef<{ disconnect: () => void } | null>(null);
  const triggerRef = useRef<((event: string, data: unknown) => void) | null>(null);
  useEffect(() => {
    const cle = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!cle || !cluster) return; // mode dégradé assumé
    let vivant = true;
    let socket: { disconnect: () => void } | null = null;

    void (async () => {
      try {
        const { default: Pusher } = await import("pusher-js");
        if (!vivant) return;
        const p = new Pusher(cle, {
          cluster,
          authEndpoint: "/api/forum/realtime-auth",
        });
        socket = p;
        pusherRef.current = p;
        const canal = p.subscribe("presence-forum");

        canal.bind("message", (m: ForumMessage) => {
          // `canDelete` n'est jamais diffusé : il dépend de qui regarde. On le recalcule ici,
          // et seul l'auteur se voit le bouton — l'admin, lui, l'obtiendra au rechargement.
          setMessages((actuels) => fusionner(actuels ?? [], [{ ...m, canDelete: false }]));
        });
        canal.bind("deleted", ({ id }: { id: string }) => {
          setMessages((actuels) => (actuels ?? []).filter((m) => m.id !== id));
        });
        canal.bind("client-typing", ({ name }: { name: string }) => {
          if (name) setFrappe((f) => ({ ...f, [name]: Date.now() }));
        });

        type Membre = { id: string; info: { name: string } };
        const majPresence = () => {
          const membres = (canal as unknown as {
            members?: { each: (cb: (m: Membre) => void) => void; me?: Membre };
          }).members;
          if (!membres) return;
          const moi = membres.me?.id;
          if (membres.me?.info?.name) monNomRef.current = membres.me.info.name;
          const noms: string[] = [];
          membres.each((m) => {
            if (m.id !== moi && m.info?.name) noms.push(m.info.name);
          });
          setPresents([...new Set(noms)].sort());
        };
        canal.bind("pusher:subscription_succeeded", majPresence);
        canal.bind("pusher:member_added", majPresence);
        canal.bind("pusher:member_removed", majPresence);
        // Une reconnexion a forcément laissé passer des messages : on rattrape.
        p.connection.bind("connected", () => void charge(limit, "rattrapage"));

        triggerRef.current = (event, data) => {
          try {
            (canal as unknown as { trigger: (e: string, d: unknown) => void }).trigger(event, data);
          } catch {
            /* le canal n'accepte pas encore les événements clients : sans importance */
          }
        };
      } catch {
        // Module absent, autorisation refusée, réseau : le fil se passe du temps réel.
      }
    })();

    return () => {
      vivant = false;
      triggerRef.current = null;
      pusherRef.current = null;
      socket?.disconnect();
    };
    // `limit` n'est volontairement PAS une dépendance : changer de page ne doit pas
    // reconstruire la connexion. Le rattrapage relit de toute façon depuis l'ancre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charge]);

  // Oubli des « en train d'écrire » : sans ce balayage, quelqu'un qui ferme son onglet en
  // pleine phrase resterait affiché comme écrivant, pour toujours.
  useEffect(() => {
    if (Object.keys(frappe).length === 0) return;
    const t = setTimeout(() => {
      const limite = Date.now() - TYPING_FORGET_MS;
      setFrappe((f) => Object.fromEntries(Object.entries(f).filter(([, at]) => at > limite)));
    }, TYPING_FORGET_MS);
    return () => clearTimeout(t);
  }, [frappe]);

  // On ne colle en bas que si on y était déjà : sinon, lire un vieux message serait
  // interrompu par chaque arrivée.
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const enBas = zone.scrollHeight - zone.scrollTop - zone.clientHeight < 120;
    if (enBas) finRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  /** Le champ grandit avec le texte, jusqu'au plafond posé en CSS (30dvh).
   *
   *  `rows={1}` seul montrerait une seule ligne d'un message de dix : on relit ce qu'on écrit
   *  aussi souvent qu'on l'écrit. Remettre `height` à `auto` avant de lire `scrollHeight` est
   *  indispensable — sans ça le champ ne sait que grandir, jamais rétrécir. */
  const ajuster = () => {
    const el = saisieRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const dernierSignal = useRef(0);
  const onDraft = (v: string) => {
    setDraft(v);
    ajuster();
    const now = Date.now();
    if (v && monNomRef.current && now - dernierSignal.current > TYPING_EVERY_MS) {
      dernierSignal.current = now;
      triggerRef.current?.("client-typing", { name: monNomRef.current });
    }
  };

  const envoyer = async () => {
    const texte = draft.trim();
    if (!texte || envoi) return;
    setEnvoi(true);
    try {
      const res = await fetch("/api/forum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: texte }),
      });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ message: ForumMessage }>(res);
      // Insertion immédiate. Le même message reviendra par le courtier : `fusionner`
      // déduplique par id, donc on ne se voit pas parler double.
      setMessages((actuels) => fusionner(actuels ?? [], [data.message]));
      setDraft("");
      // Le champ vidé doit REDESCENDRE : sans ça il garde la hauteur du message envoyé.
      requestAnimationFrame(ajuster);
      setErreur(null);
    } catch (e) {
      toastRef.current("err", e instanceof Error ? e.message : "Envoi impossible");
    } finally {
      setEnvoi(false);
    }
  };

  const supprimer = async (id: string) => {
    try {
      const res = await fetch(`/api/forum/${id}`, { method: "DELETE" });
      if (onExpiredRef.current(res.status)) return;
      await readOk(res);
      setMessages((actuels) => (actuels ?? []).filter((m) => m.id !== id));
    } catch (e) {
      toastRef.current("err", e instanceof Error ? e.message : "Suppression impossible");
    }
  };

  const basculerNotifs = async () => {
    const voulu = !muted;
    setMuted(voulu); // optimiste : un réglage qui met une seconde à réagir se re-clique
    try {
      const res = await fetch("/api/forum", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muted: voulu }),
      });
      if (onExpiredRef.current(res.status)) return;
      await readOk(res);
      toastRef.current("ok", voulu ? "Notifications du fil coupées" : "Notifications rétablies");
    } catch {
      setMuted(!voulu); // on remet ce que la base dit encore
      toastRef.current("err", "Réglage non enregistré");
    }
  };

  const restant = MAX_FORUM_LEN - forumLength(draft);
  const nomsFrappe = useMemo(() => Object.keys(frappe).filter(Boolean).sort(), [frappe]);

  return (
    <section className="forum" aria-label="Fil de discussion du club">
      <header className="forum-head">
        <h2>💬 Le fil du club</h2>
        <div className="forum-head-right">
          {presents.length > 0 && (
            <p className="forum-presents" title={presents.join(", ")}>
              {presents.length === 1
                ? `${presents[0]} est en ligne`
                : `${presents.length} membres en ligne`}
            </p>
          )}
          {/* La note de confidentialité promet que ce réglage existe « depuis le fil
              lui-même » : ce bouton est ce qui rend la phrase vraie. */}
          <button
            type="button"
            className="secondary forum-mute"
            onClick={() => void basculerNotifs()}
            aria-pressed={muted}
            title={
              muted
                ? "Tu ne reçois plus de notification du fil"
                : "Tu reçois une notification à chaque message"
            }
          >
            {muted ? "🔕 Notifications coupées" : "🔔 Notifications"}
          </button>
        </div>
      </header>

      <div className="forum-scroll" ref={zoneRef}>
        {messages === null ? (
          <Skeleton />
        ) : messages.length === 0 ? (
          <EmptyState
            icon="💬"
            text={erreur ?? "Personne n'a encore rien dit. Lance la conversation."}
          />
        ) : (
          <>
            {hasMore && (
              <button
                type="button"
                className="secondary forum-plus"
                onClick={() => setLimit((l) => l + PAGE)}
              >
                Charger les messages plus anciens
              </button>
            )}
            {erreur && <p className="forum-erreur">{erreur}</p>}
            <ul className="forum-list">
              {messages.map((m) => (
                <li key={m.id} className={m.canDelete ? "forum-msg is-mine" : "forum-msg"}>
                  <div className="forum-msg-head">
                    <strong>{m.authorName}</strong>
                    <small>{horodatage(m.createdAt)}</small>
                    {m.canDelete && (
                      <button
                        type="button"
                        className="forum-suppr"
                        onClick={() => void supprimer(m.id)}
                        aria-label={`Supprimer le message de ${m.authorName}`}
                      >
                        Suppr.
                      </button>
                    )}
                  </div>
                  {/* Nœud texte : pas de markdown, pas de HTML. `pre-wrap` rend les retours
                      à la ligne que `parseForumBody` a pris soin de préserver. */}
                  <p className="forum-msg-body">{m.body}</p>
                </li>
              ))}
            </ul>
            <div ref={finRef} />
          </>
        )}
      </div>

      <p className="forum-typing" aria-live="polite">
        {nomsFrappe.length === 1
          ? `${nomsFrappe[0]} écrit…`
          : nomsFrappe.length > 1
            ? "Plusieurs membres écrivent…"
            : " "}
      </p>

      <form
        className="forum-form"
        onSubmit={(e) => {
          e.preventDefault();
          void envoyer();
        }}
      >
        <textarea
          className="forum-input"
          ref={saisieRef}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder="Écrire au club…"
          rows={1}
          aria-label="Votre message"
          onKeyDown={(e) => {
            // Entrée envoie, Maj+Entrée passe à la ligne — la convention de toutes les
            // messageries. Sur mobile le clavier a son propre bouton, qui insère un saut.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void envoyer();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || envoi} className="forum-envoi">
          {envoi ? "…" : "Envoyer"}
        </button>
      </form>
      {restant < 100 && (
        <p className="forum-restant" aria-live="polite">
          {restant >= 0 ? `${restant} caractères restants` : "Message trop long"}
        </p>
      )}
    </section>
  );
}
