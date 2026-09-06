"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import { EmptyState, Skeleton } from "@/components/Placeholders";
import {
  MAX_FORUM_LEN,
  forumLength,
  FORUM_EMOJIS,
  FORUM_REACTIONS,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  MAX_POLL_OPTION_LEN,
  forumPreview,
} from "@/lib/forum";
import { segmenter, libelleJour, memeJour } from "@/lib/forum-texte";
import { initiales } from "@/lib/forum-avatar";

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
//
// ⚠️ AUCUN booléen « c'est à moi » ni « je peux supprimer » ne vient du serveur par ligne.
// Ils dépendent de qui regarde, pas du message, et les figer côté serveur obligeait à en
// inventer un pour la diffusion — d'où un admin qui voyait tout le fil aligné à droite, et un
// message reçu en direct qui n'avait pas le même comportement que le même après rechargement.
// Le serveur envoie `meId` et `admin` UNE fois avec la page ; tout le reste se dérive ici.

export type ForumMessage = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  replyToId?: string | null;
  replyToAuthor?: string | null;
  replyToExcerpt?: string | null;
};

type Membre = { id: string; name: string };
type ReactionRow = { emoji: string; users: Membre[] };
type PollOption = { id: string; label: string; voters: Membre[] };
type Poll = { id: string; messageId: string; closedAt: string | null; options: PollOption[] };

type Charge = {
  messages: ForumMessage[];
  reactions?: Record<string, ReactionRow[]>;
  polls?: Record<string, Poll>;
  hasMore?: boolean;
  muted?: boolean;
  meId?: string;
  meName?: string;
  admin?: boolean;
  /**
   * `true` = cette réponse se SUBSTITUE à ce qu'on détient ; `false` = elle le complète.
   *
   * C'est le SERVEUR qui le dit, et pas le mode qu'on a demandé : une ancre inconnue ou une
   * absence trop longue le font retomber sur une page entière. Absent (vieux serveur) : on
   * substitue, ce qui est le comportement sûr.
   */
  complet?: boolean;
  /** La fenêtre visible telle qu'elle est ENCORE en base — cf. `elaguer` plus bas. */
  fenetre?: { ids: string[]; depuis: string };
};

/**
 * Remplace les entrées d'un dictionnaire pour les seuls identifiants que la réponse COUVRE.
 *
 * Un `{ ...actuel, ...recu }` ne sait pas retirer : une réaction annulée pendant une coupure
 * n'apparaît dans aucune réponse, donc rien n'écrasait l'entrée périmée et la pastille restait
 * affichée pour toujours. On efface donc d'abord tout ce que le serveur dit connaître, puis on
 * repose ce qu'il rend — un message couvert sans aucune réaction perd bien la sienne. Ce qu'il
 * ne couvre pas (des messages plus anciens chargés à la demande) n'est pas touché.
 */
function remplacerCouverts<T>(
  actuel: Record<string, T>,
  recu: Record<string, T> | undefined,
  couverts: readonly string[],
): Record<string, T> {
  const out = { ...actuel };
  for (const id of couverts) delete out[id];
  return { ...out, ...(recu ?? {}) };
}

const PAGE = 30;
/** Une frappe au plus toutes les 3 s : sans ce frein, la saisie ferait dix fois le volume des messages. */
const TYPING_EVERY_MS = 3_000;
/** Au-delà, on considère que la personne a cessé d'écrire (elle a pu fermer l'onglet). */
const TYPING_FORGET_MS = 5_000;

/** L'heure d'un message, à la SECONDE.
 *
 *  Les secondes sont inhabituelles dans une messagerie, mais c'est le cas normal d'une
 *  conversation vive : trois messages tombent dans la même minute et l'ordre de la liste est
 *  alors la seule chose qui les sépare. Le JOUR, lui, est porté par le séparateur de date —
 *  le répéter sur chaque ligne était du bruit. */
const horodatage = (iso: string): string =>
  new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

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

/** Rend le corps d'un message : du texte, et des liens qui en sont des nœuds React.
 *
 *  Jamais de HTML fabriqué — `segmenter` ne rend que des données, et c'est React qui crée les
 *  éléments. Il n'y a donc aucun point d'injection, quoi qu'un membre écrive. */
function Corps({ texte }: { texte: string }) {
  const parts = useMemo(() => segmenter(texte), [texte]);
  return (
    <p className="forum-msg-body">
      {parts.map((p, i) =>
        p.type === "lien" ? (
          <a key={i} href={p.valeur} target="_blank" rel="noopener noreferrer nofollow">
            {p.valeur}
          </a>
        ) : (
          <span key={i}>{p.valeur}</span>
        ),
      )}
    </p>
  );
}

export default function Forum({
  toast,
  onExpired,
}: {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [messages, setMessages] = useState<ForumMessage[] | null>(null);
  const [reactions, setReactions] = useState<Record<string, ReactionRow[]>>({});
  const [polls, setPolls] = useState<Record<string, Poll>>({});
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [erreur, setErreur] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [envoi, setEnvoi] = useState(false);
  /** Qui est connecté au fil, hors soi — vient de la présence du canal, jamais de la base. */
  const [presents, setPresents] = useState<string[]>([]);
  /**
   * Qui tape en ce moment : `id -> { name, at }`, avec l'instant du dernier signal.
   *
   * INDEXÉ PAR IDENTIFIANT et non par nom : deux homonymes — un club en a — se confondaient en
   * une seule personne, et l'un faisait taire l'autre. Le nom voyage à côté, pour l'affichage.
   */
  const [frappe, setFrappe] = useState<Record<string, { name: string; at: number }>>({});
  /** Notifications du fil coupées ? OPT-OUT : `false` par défaut, sinon le fil ne vit pas. */
  const [muted, setMuted] = useState(false);
  /** Qui regarde. Sert à dériver l'alignement ET le droit de supprimer, pour TOUTE arrivée. */
  const [moi, setMoi] = useState<{ id: string; name: string; admin: boolean } | null>(null);
  /** Le message auquel on répond, s'il y en a un. */
  const [citation, setCitation] = useState<ForumMessage | null>(null);
  /** Palettes ouvertes : celle de la saisie, et celle des réactions d'un message donné. */
  const [paletteSaisie, setPaletteSaisie] = useState(false);
  const [paletteReaction, setPaletteReaction] = useState<string | null>(null);
  /** Composeur de sondage : `null` = fermé. */
  const [sondage, setSondage] = useState<{ question: string; options: string[] } | null>(null);

  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** Le dernier message connu : c'est l'ancre du rattrapage après une coupure. */
  const dernierRef = useRef<string | null>(null);
  /** La taille de fenêtre COURANTE, pour les rattrapages déclenchés hors du cycle de rendu.
   *  Sans elle, le gestionnaire du courtier — monté une fois pour toutes — rattraperait
   *  éternellement sur la première valeur de `limit`, et demanderait au serveur une fenêtre
   *  plus étroite que celle qu'on affiche. */
  const limitRef = useRef(limit);
  limitRef.current = limit;
  /** Réactions déjà parties et non encore revenues, par « message|emoji ». Sans ce garde, un
   *  double-clic lançait deux bascules concurrentes que la base refusait. */
  const reacEnVolRef = useRef<Set<string>>(new Set());
  /** Écritures de sondage déjà parties, par sondage — même raison. */
  const voteEnVolRef = useRef<Set<string>>(new Set());
  /** Numéro de la dernière écriture émise par sondage. Une réponse dont le numéro n'est plus
   *  le dernier est PÉRIMÉE : l'appliquer laisserait une réponse ancienne écraser une plus
   *  récente, et afficher un état faux jusqu'au prochain événement du courtier. */
  const voteSeqRef = useRef<Record<string, number>>({});
  /** Mon nom d'affichage, tel que la présence le connaît — c'est lui qu'on signe en tapant. */
  const monNomRef = useRef<string>("");
  const finRef = useRef<HTMLDivElement | null>(null);
  /** Hauteur de la liste juste avant d'insérer des messages plus anciens — cf. l'effet de
   *  défilement plus bas. `null` = aucune insertion en cours par le haut. */
  const ancrageRef = useRef<number | null>(null);
  /** Qui je suis, lisible depuis un gestionnaire monté une fois pour toutes (la frappe). */
  const moiRef = useRef<{ id: string; name: string; admin: boolean } | null>(null);
  moiRef.current = moi;
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const saisieRef = useRef<HTMLTextAreaElement | null>(null);

  const charge = useCallback(
    async (n: number, mode: "page" | "rattrapage" = "page") => {
      try {
        const ancre = dernierRef.current;
        // `limit` voyage AUSSI en rattrapage : il dit au serveur quelle fenêtre on a sous les
        // yeux, donc sur quels messages il doit rendre l'état des réactions, des sondages et
        // des suppressions. Sans lui, le rattrapage ne portait que les messages neufs.
        const qs =
          mode === "rattrapage" && ancre
            ? `?since=${encodeURIComponent(ancre)}&limit=${n}`
            : `?limit=${n}`;
        const res = await fetch(`/api/forum${qs}`);
        if (onExpiredRef.current(res.status)) return;
        const data = await readOk<Charge>(res);
        if (typeof data.muted === "boolean") setMuted(data.muted);
        if (data.meId) {
          const id = data.meId;
          // On GARDE le nom qu'on avait quand la réponse ne le porte pas. `data.meId` suffisait
          // à entrer ici, et le rattrapage ne servait pas `meName` : le nom retombait sur
          // « Moi », qui s'inscrivait ensuite dans l'infobulle des réactants à la première
          // réaction posée. Le serveur le renvoie maintenant dans les deux modes ; cette
          // ceinture tient de toute façon face à une réponse partielle.
          setMoi((avant) => ({
            id,
            name: data.meName ?? avant?.name ?? "Moi",
            admin: Boolean(data.admin),
          }));
          if (!monNomRef.current && data.meName) monNomRef.current = data.meName;
        }
        setErreur(null);
        // C'est le SERVEUR qui dit si sa réponse remplace ou complète, pas le mode demandé :
        // une ancre inconnue ou une absence trop longue lui font rendre une page entière.
        const complet = data.complet !== false;
        const fenetre = data.fenetre;
        const neufs = data.messages.map((m) => m.id);
        setMessages((actuels) => {
          if (complet) return data.messages;
          const fusion = fusionner(actuels ?? [], data.messages);
          if (!fenetre) return fusion;
          // ÉLAGAGE — le seul canal qui rattrape une suppression manquée. Ce que le serveur ne
          // liste plus dans sa fenêtre n'existe plus. On ne touche qu'à l'intervalle qu'il
          // couvre : au-delà (`depuis`), on détient des messages plus anciens chargés à la
          // demande, dont il n'a rien dit.
          const vus = new Set([...fenetre.ids, ...neufs]);
          return fusion.filter((m) => m.createdAt < fenetre.depuis || vus.has(m.id));
        });
        const couverts = complet ? [] : [...(fenetre?.ids ?? []), ...neufs];
        setReactions((r) =>
          complet ? (data.reactions ?? {}) : remplacerCouverts(r, data.reactions, couverts),
        );
        setPolls((p) => (complet ? (data.polls ?? {}) : remplacerCouverts(p, data.polls, couverts)));
        if (complet) setHasMore(Boolean(data.hasMore));
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

  /** Applique le DELTA d'une réaction. Idempotent : rejouer le même delta ne change rien, ce
   *  qui permet de l'appliquer en optimiste PUIS à l'arrivée du courtier sans compter double. */
  const appliquerReaction = useCallback(
    (d: { messageId: string; emoji: string; userId: string; userName: string; on: boolean }) => {
      setReactions((r) => {
        const liste = (r[d.messageId] ?? []).map((x) => ({ ...x, users: [...x.users] }));
        const i = liste.findIndex((x) => x.emoji === d.emoji);
        if (d.on) {
          if (i < 0) liste.push({ emoji: d.emoji, users: [{ id: d.userId, name: d.userName }] });
          else if (!liste[i].users.some((u) => u.id === d.userId)) {
            liste[i].users.push({ id: d.userId, name: d.userName });
          }
        } else if (i >= 0) {
          liste[i].users = liste[i].users.filter((u) => u.id !== d.userId);
          if (liste[i].users.length === 0) liste.splice(i, 1);
        }
        return { ...r, [d.messageId]: liste };
      });
    },
    [],
  );

  /** Retire un message partout — y compris les citations qui le reprenaient. */
  const retirer = useCallback((id: string) => {
    setMessages((actuels) =>
      (actuels ?? [])
        .filter((m) => m.id !== id)
        // La base fait exactement ce geste, par le `ON DELETE SET NULL` de `replyToId` : la
        // citation entière disparaît, pas seulement son texte. On l'imite ICI AUSSI, sinon
        // l'écran divergerait selon le chemin — « Message supprimé » en direct, plus rien du
        // tout après rechargement.
        .map((m) =>
          m.replyToId === id
            ? { ...m, replyToId: null, replyToAuthor: null, replyToExcerpt: null }
            : m,
        ),
    );
    setReactions(({ [id]: _oublie, ...reste }) => reste);
    setPolls(({ [id]: _aussi, ...reste }) => reste);
    // La barre « Réponse à … » cite un message qui vient de disparaître : la laisser afficherait
    // son texte pendant qu'on rédige, et l'envoi partirait de toute façon sans citation.
    setCitation((c) => (c?.id === id ? null : c));
  }, []);

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
        const canal = p.subscribe("presence-forum");

        // Un message, et RIEN d'autre : la ligne reçue ici a exactement la forme de celle que
        // le GET renvoie. La route sondage greffait un champ `poll` sur cet événement, ce qui
        // obligeait le client à connaître une seconde forme de message ; elle émet maintenant
        // un événement `poll` distinct, celui-là même qu'écoutent déjà le vote et la clôture.
        canal.bind("message", (m: ForumMessage) => {
          setMessages((actuels) => fusionner(actuels ?? [], [m]));
        });
        canal.bind("deleted", ({ id }: { id: string }) => retirer(id));
        canal.bind("reaction", appliquerReaction);
        canal.bind("poll", (p: Poll) => setPolls((x) => ({ ...x, [p.messageId]: p })));
        canal.bind("client-typing", ({ id, name }: { id?: string; name: string }) => {
          if (!name) return;
          // `id ?? name` : un client d'une version antérieure n'envoie que le nom. Il retombe
          // alors sur l'ancien comportement plutôt que de disparaître de l'affichage.
          setFrappe((f) => ({ ...f, [id ?? name]: { name, at: Date.now() } }));
        });

        type MembrePresence = { id: string; info: { name: string } };
        const majPresence = () => {
          const membres = (canal as unknown as {
            members?: { each: (cb: (m: MembrePresence) => void) => void; me?: MembrePresence };
          }).members;
          if (!membres) return;
          const monId = membres.me?.id;
          if (membres.me?.info?.name) monNomRef.current = membres.me.info.name;
          const noms: string[] = [];
          membres.each((m) => {
            if (m.id !== monId && m.info?.name) noms.push(m.info.name);
          });
          setPresents([...new Set(noms)].sort());
        };
        canal.bind("pusher:subscription_succeeded", majPresence);
        canal.bind("pusher:member_added", majPresence);
        canal.bind("pusher:member_removed", majPresence);
        // Une RE-connexion a forcément laissé passer des messages : on rattrape. La PREMIÈRE
        // connexion, non — `connecting → connected` déclenche pourtant le même événement, et
        // l'ouverture du fil payait donc deux chargements complets, dont un en mode rattrapage
        // avec une ancre encore nulle : il retombait sur `?limit=`, et son résultat était
        // fusionné avec ce que le mode page allait ensuite substituer. Un message écrit dans
        // cet intervalle était inséré par le courtier puis effacé par la substitution.
        let dejaConnecte = false;
        p.connection.bind("connected", () => {
          if (dejaConnecte) void charge(limitRef.current, "rattrapage");
          dejaConnecte = true;
        });

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
      socket?.disconnect();
    };
    // `limit` n'est volontairement PAS une dépendance : changer de page ne doit pas
    // reconstruire la connexion. Le rattrapage relit de toute façon depuis l'ancre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charge, retirer, appliquerReaction]);

  // Oubli des « en train d'écrire » : sans ce balayage, quelqu'un qui ferme son onglet en
  // pleine phrase resterait affiché comme écrivant, pour toujours.
  //
  // ⚠️ UN INTERVALLE, ET NON UN DÉLAI RELANCÉ. La version précédente reposait un `setTimeout`
  // de 5 s à chaque changement de `frappe` — or `client-typing` arrive toutes les 3 s tant que
  // quelqu'un tape : le délai était annulé avant d'échoir, et le cas que le commentaire dit
  // vouloir couvrir ne se produisait JAMAIS. Un balayage régulier ne dépend, lui, d'aucune
  // arrivée. Il ne tourne que tant qu'il y a quelqu'un à oublier.
  const quelquUnTape = Object.keys(frappe).length > 0;
  useEffect(() => {
    if (!quelquUnTape) return;
    const t = setInterval(() => {
      const limite = Date.now() - TYPING_FORGET_MS;
      setFrappe((f) => {
        const restants = Object.entries(f).filter(([, v]) => v.at > limite);
        // On ne remplace l'objet que s'il change vraiment : sinon chaque tour redéclencherait
        // un rendu pour rien.
        return restants.length === Object.keys(f).length ? f : Object.fromEntries(restants);
      });
    }, 1_000);
    return () => clearInterval(t);
  }, [quelquUnTape]);

  // On ne colle en bas que si on y était déjà : sinon, lire un vieux message serait
  // interrompu par chaque arrivée.
  //
  // Sauf après un « charger les messages plus anciens » : là, on rend sa place au lecteur en
  // décalant le défilement de la hauteur exactement gagnée. C'est le seul geste du fil qui
  // insère AU-DESSUS de ce qu'on regarde.
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const avant = ancrageRef.current;
    if (avant !== null) {
      ancrageRef.current = null;
      zone.scrollTop += zone.scrollHeight - avant;
      return;
    }
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
      triggerRef.current?.("client-typing", { id: moiRef.current?.id, name: monNomRef.current });
    }
  };

  /** Insère un emoji À LA POSITION DU CURSEUR, et pas en fin de champ : on ajoute souvent un
   *  emoji au milieu d'une phrase déjà écrite. */
  const insererEmoji = (e: string) => {
    const el = saisieRef.current;
    const debut = el?.selectionStart ?? draft.length;
    const fin = el?.selectionEnd ?? draft.length;
    const suivant = draft.slice(0, debut) + e + draft.slice(fin);
    setDraft(suivant);
    setPaletteSaisie(false);
    requestAnimationFrame(() => {
      ajuster();
      el?.focus();
      const pos = debut + e.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  const envoyer = async () => {
    const texte = draft.trim();
    if (!texte || envoi) return;
    // Ce qui était dans le champ AU MOMENT DE L'ENVOI. Le champ reste actif pendant la
    // requête — c'est voulu, on continue souvent la conversation — mais le vider ensuite sans
    // regarder effaçait ce qui avait été tapé dans l'intervalle. Sur 3G, c'est une phrase
    // entière perdue sans trace.
    const partiDe = draft;
    setEnvoi(true);
    try {
      const res = await fetch("/api/forum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: texte, replyTo: citation?.id ?? undefined }),
      });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ message: ForumMessage }>(res);
      // Insertion immédiate. Le même message reviendra par le courtier : `fusionner`
      // déduplique par id, donc on ne se voit pas parler double.
      setMessages((actuels) => fusionner(actuels ?? [], [data.message]));
      // On n'efface QUE ce qu'on a envoyé : si le texte a changé pendant la requête, il
      // appartient au message suivant et doit rester.
      setDraft((courant) => (courant === partiDe ? "" : courant));
      setCitation(null);
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
      retirer(id);
    } catch (e) {
      toastRef.current("err", e instanceof Error ? e.message : "Suppression impossible");
    }
  };

  const reagir = async (messageId: string, emoji: string) => {
    if (!moi) return;
    setPaletteReaction(null);
    // UNE BASCULE À LA FOIS PAR PASTILLE. C'est une bascule, donc deux appels concurrents ne
    // sont pas deux fois le même geste : ils se défont l'un l'autre, et se croisent en base.
    // Le second clic est ignoré plutôt que mis en file — c'est ce que veut dire un doigt qui
    // insiste sur un bouton qui n'a pas encore répondu.
    const cle = `${messageId}|${emoji}`;
    if (reacEnVolRef.current.has(cle)) return;
    reacEnVolRef.current.add(cle);
    const deja = (reactions[messageId] ?? [])
      .find((r) => r.emoji === emoji)
      ?.users.some((u) => u.id === moi.id);
    const delta = { messageId, emoji, userId: moi.id, userName: moi.name, on: !deja };
    appliquerReaction(delta); // optimiste : une pastille qui met une seconde à réagir se re-clique
    try {
      const res = await fetch(`/api/forum/${messageId}/reaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      });
      if (onExpiredRef.current(res.status)) return;
      await readOk(res);
    } catch {
      appliquerReaction({ ...delta, on: Boolean(deja) }); // on remet ce que la base dit encore
      toastRef.current("err", "Réaction non enregistrée");
    } finally {
      reacEnVolRef.current.delete(cle);
    }
  };

  const voter = async (poll: Poll, optionId: string) => {
    if (!moi || poll.closedAt) return;
    // Un seul vote en vol par sondage : deux clics rapprochés partaient sinon en même temps, et
    // le second remplaçait un état que le premier n'avait pas fini d'écrire.
    if (voteEnVolRef.current.has(poll.id)) return;
    voteEnVolRef.current.add(poll.id);
    const ticket = (voteSeqRef.current[poll.id] ?? 0) + 1;
    voteSeqRef.current[poll.id] = ticket;
    const coches = poll.options.filter((o) => o.voters.some((v) => v.id === moi.id)).map((o) => o.id);
    const voulus = coches.includes(optionId)
      ? coches.filter((x) => x !== optionId)
      : [...coches, optionId];
    const avant = poll;
    // Optimiste, comme les réactions : cocher une case doit répondre au doigt.
    setPolls((x) => ({
      ...x,
      [poll.messageId]: {
        ...poll,
        options: poll.options.map((o) => ({
          ...o,
          voters: voulus.includes(o.id)
            ? o.voters.some((v) => v.id === moi.id)
              ? o.voters
              : [...o.voters, { id: moi.id, name: moi.name }]
            : o.voters.filter((v) => v.id !== moi.id),
        })),
      },
    }));
    try {
      const res = await fetch(`/api/forum/poll/${poll.id}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionIds: voulus }),
      });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ poll: Poll | null }>(res);
      // On n'applique QUE si notre ticket est encore le dernier émis pour ce sondage : une
      // clôture partie entre-temps rendrait sinon un état plus récent que cette réponse
      // écraserait, et l'écran mentirait jusqu'au prochain événement du courtier.
      if (data.poll && voteSeqRef.current[poll.id] === ticket) {
        setPolls((x) => ({ ...x, [data.poll!.messageId]: data.poll! }));
      }
    } catch (e) {
      setPolls((x) => ({ ...x, [avant.messageId]: avant }));
      toastRef.current("err", e instanceof Error ? e.message : "Vote non enregistré");
    } finally {
      voteEnVolRef.current.delete(poll.id);
    }
  };

  const clore = async (poll: Poll) => {
    // Même ticket que le vote, et à dessein le MÊME compteur : clore et voter écrivent le même
    // sondage, donc c'est entre eux deux que la course se joue.
    const ticket = (voteSeqRef.current[poll.id] ?? 0) + 1;
    voteSeqRef.current[poll.id] = ticket;
    try {
      const res = await fetch(`/api/forum/poll/${poll.id}/vote`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closed: !poll.closedAt }),
      });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ poll: Poll | null }>(res);
      if (data.poll && voteSeqRef.current[poll.id] === ticket) {
        setPolls((x) => ({ ...x, [data.poll!.messageId]: data.poll! }));
      }
    } catch {
      toastRef.current("err", "Modification impossible");
    }
  };

  const creerSondage = async () => {
    if (!sondage || envoi) return;
    setEnvoi(true);
    try {
      const res = await fetch("/api/forum/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: sondage.question, options: sondage.options }),
      });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ message: ForumMessage; poll: Poll }>(res);
      setMessages((actuels) => fusionner(actuels ?? [], [data.message]));
      setPolls((x) => ({ ...x, [data.poll.messageId]: data.poll }));
      setSondage(null);
    } catch (e) {
      toastRef.current("err", e instanceof Error ? e.message : "Sondage impossible");
    } finally {
      setEnvoi(false);
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
  /** Le seul palier franchi, pour l'annonce vocale — cf. la région `aria-live` en bas. */
  const palierRestant = useMemo(() => {
    if (restant < 0) return "Message trop long, il ne partira pas";
    for (const seuil of [0, 20, 50, 100]) {
      if (restant <= seuil) return `${seuil === 0 ? "Plus aucun" : `Moins de ${seuil}`} caractère${seuil > 1 ? "s" : ""} restant${seuil > 1 ? "s" : ""}`;
    }
    return "";
  }, [restant]);
  const nomsFrappe = useMemo(
    () => [...new Set(Object.values(frappe).map((f) => f.name).filter(Boolean))].sort(),
    [frappe],
  );

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
          {/* NOM STABLE + `aria-pressed`, et non un nom qui change AVEC l'état. Les deux
              ensemble donnaient « Notifications coupées, bouton, enfoncé » : impossible de
              savoir si « coupées » décrit l'état courant ou ce que le clic va faire. Le nom
              accessible dit ce que le bouton GOUVERNE, l'état pressé dit où il en est. Le
              libellé visible, lui, garde son icône — elle se lit d'un coup d'œil. */}
          <button
            type="button"
            className="secondary forum-mute"
            onClick={() => void basculerNotifs()}
            aria-pressed={muted}
            aria-label="Couper les notifications du fil"
            title={
              muted
                ? "Tu ne reçois plus de notification du fil"
                : "Tu reçois une notification à chaque message"
            }
          >
            <span aria-hidden="true">{muted ? "🔕 Notifications coupées" : "🔔 Notifications"}</span>
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
                onClick={() => {
                  // On MÉMORISE la hauteur avant d'insérer : trente messages ajoutés au-dessus
                  // poussent tout le reste vers le bas, et sans compensation on perd la ligne
                  // qu'on était en train de lire — celle même qu'on remontait chercher.
                  ancrageRef.current = zoneRef.current?.scrollHeight ?? null;
                  setLimit((l) => l + PAGE);
                }}
              >
                Charger les messages plus anciens
              </button>
            )}
            {erreur && <p className="forum-erreur">{erreur}</p>}
            <ul className="forum-list">
              {messages.map((m, i) => {
                // Dérivés de `meId`/`admin`, jamais reçus par ligne : c'est ce qui fait qu'un
                // admin ne se voit pas attribuer les messages des autres.
                const mine = moi !== null && m.authorId === moi.id;
                const canDelete = mine || (moi?.admin ?? false);
                const precedent = i > 0 ? messages[i - 1] : null;
                const nouveauJour = !precedent || !memeJour(precedent.createdAt, m.createdAt);
                const reacs = reactions[m.id] ?? [];
                const poll = polls[m.id];
                return (
                  <li key={m.id} className="forum-ligne">
                    {nouveauJour && (
                      <p className="forum-jour" role="presentation">
                        <span>{libelleJour(m.createdAt)}</span>
                      </p>
                    )}
                    <div className={mine ? "forum-rangee is-mine" : "forum-rangee"}>
                      {/* Pastille NEUTRE : DESIGN.md réserve la couleur au sens, et
                          « c'est moi qui parle » se dit ici par l'alignement. Cachée pour ses
                          propres messages — on sait qui on est. */}
                      {!mine && (
                        <span className="forum-avatar" aria-hidden="true">
                          {initiales(m.authorName)}
                        </span>
                      )}
                      <div className={mine ? "forum-msg is-mine" : "forum-msg"}>
                        {/* Les trois champs de la citation vont ensemble : ou bien la cible
                            existe encore et ils sont tous renseignés, ou bien elle a disparu et
                            ils sont tous nuls. Pas de branche « Message supprimé » — la base
                            n'en garde aucune trace, donc l'écran non plus. */}
                        {m.replyToExcerpt && (
                          <p className="forum-citation">
                            <strong>{m.replyToAuthor}</strong>
                            <span>{m.replyToExcerpt}</span>
                          </p>
                        )}
                        <div className="forum-msg-head">
                          <strong>{m.authorName}</strong>
                          <small>{horodatage(m.createdAt)}</small>
                          <span className="forum-actions">
                            <button
                              type="button"
                              className="forum-action"
                              onClick={() => {
                                setCitation(m);
                                saisieRef.current?.focus();
                              }}
                              aria-label={`Répondre à ${m.authorName}`}
                            >
                              Répondre
                            </button>
                            <button
                              type="button"
                              className="forum-action"
                              onClick={() =>
                                setPaletteReaction((x) => (x === m.id ? null : m.id))
                              }
                              aria-expanded={paletteReaction === m.id}
                              aria-label={`Réagir au message de ${m.authorName}`}
                            >
                              ⊕
                            </button>
                            {canDelete && (
                              <button
                                type="button"
                                className="forum-action forum-suppr"
                                onClick={() => void supprimer(m.id)}
                                aria-label={`Supprimer le message de ${m.authorName}`}
                              >
                                Suppr.
                              </button>
                            )}
                          </span>
                        </div>
                        <Corps texte={m.body} />

                        {poll && moi && (
                          <div className="forum-poll">
                            {(() => {
                              // Le nombre de VOTANTS, pas la somme des voix : en choix
                              // multiple les deux diffèrent, et c'est le premier qui sert de
                              // base aux barres — sinon 100 % est inatteignable et les
                              // proportions mentent.
                              const votants = new Set(
                                poll.options.flatMap((o) => o.voters.map((v) => v.id)),
                              );
                              const voix = poll.options.reduce((n, o) => n + o.voters.length, 0);
                              return (
                                <>
                                  {poll.options.map((o) => {
                                    const coche = o.voters.some((v) => v.id === moi.id);
                                    const part = votants.size
                                      ? Math.round((o.voters.length / votants.size) * 100)
                                      : 0;
                                    return (
                                      <button
                                        key={o.id}
                                        type="button"
                                        className={coche ? "forum-opt is-coche" : "forum-opt"}
                                        onClick={() => void voter(poll, o.id)}
                                        disabled={Boolean(poll.closedAt)}
                                        aria-pressed={coche}
                                        title={
                                          o.voters.length
                                            ? o.voters.map((v) => v.name).join(", ")
                                            : "Personne pour l'instant"
                                        }
                                        // ⚠️ Pico applique `pointer-events: none` aux boutons
                                        // `[disabled]` : sur un sondage CLOS, l'infobulle
                                        // disparaît même à la souris — au moment précis où
                                        // l'on veut lire le résultat. Le nom accessible reste,
                                        // lui, disponible dans tous les cas ; et les votants
                                        // sont écrits en clair sous la barre quand c'est clos.
                                        aria-label={`${o.label}, ${o.voters.length} voix${
                                          o.voters.length
                                            ? ` : ${o.voters.map((v) => v.name).join(", ")}`
                                            : ""
                                        }`}
                                      >
                                        <span
                                          className="forum-opt-jauge"
                                          style={{ width: `${part}%` }}
                                          aria-hidden="true"
                                        />
                                        <span className="forum-opt-texte">
                                          {coche ? "☑" : "☐"} {o.label}
                                        </span>
                                        <span className="forum-opt-nb">{o.voters.length}</span>
                                      </button>
                                    );
                                  })}
                                  {/* Sur un sondage CLOS, les votants passent EN CLAIR sous la
                                      barre : c'est là qu'on vient lire qui vient, et c'est
                                      exactement là que Pico rend les infobulles inatteignables. */}
                                  {poll.closedAt &&
                                    poll.options.map((o) =>
                                      o.voters.length ? (
                                        <p key={o.id} className="forum-poll-votants">
                                          <strong>{o.label}</strong> :{" "}
                                          {o.voters.map((v) => v.name).join(", ")}
                                        </p>
                                      ) : null,
                                    )}
                                  <p className="forum-poll-pied">
                                    {votants.size} votant{votants.size > 1 ? "s" : ""} · {voix}{" "}
                                    voix
                                    {poll.closedAt ? " · clos" : ""}
                                    {canDelete && (
                                      <button
                                        type="button"
                                        className="forum-action"
                                        onClick={() => void clore(poll)}
                                      >
                                        {poll.closedAt ? "Rouvrir" : "Clore"}
                                      </button>
                                    )}
                                  </p>
                                </>
                              );
                            })()}
                          </div>
                        )}

                        {(reacs.length > 0 || paletteReaction === m.id) && (
                          <div className="forum-reacs">
                            {reacs.map((r) => {
                              const mienne = moi !== null && r.users.some((u) => u.id === moi.id);
                              return (
                                <button
                                  key={r.emoji}
                                  type="button"
                                  className={mienne ? "forum-reac is-mienne" : "forum-reac"}
                                  onClick={() => void reagir(m.id, r.emoji)}
                                  aria-pressed={mienne}
                                  title={r.users.map((u) => u.name).join(", ")}
                                  // Le `title` ne s'ouvre pas au doigt : le nom accessible
                                  // porte donc la même information, pour le lecteur d'écran
                                  // comme pour le tactile.
                                  aria-label={`${r.emoji} ${r.users.length} : ${r.users
                                    .map((u) => u.name)
                                    .join(", ")}`}
                                >
                                  {r.emoji} {r.users.length}
                                </button>
                              );
                            })}
                            {/* LA PALETTE MONTRE CE QU'ON A DÉJÀ POSÉ. Ses six boutons appellent
                                `reagir`, qui BASCULE : cliquer 👍 alors qu'on l'avait déjà mis
                                le retirait, sans que rien à l'écran ne l'annonce. Le filet
                                `is-mienne` et `aria-pressed` disent l'état avant le clic, et
                                le libellé accessible dit ce que le clic va faire. */}
                            {paletteReaction === m.id &&
                              FORUM_REACTIONS.map((e) => {
                                const posee =
                                  moi !== null &&
                                  (reacs.find((r) => r.emoji === e)?.users ?? []).some(
                                    (u) => u.id === moi.id,
                                  );
                                return (
                                  <button
                                    key={e}
                                    type="button"
                                    className={
                                      posee
                                        ? "forum-reac forum-reac-choix is-mienne"
                                        : "forum-reac forum-reac-choix"
                                    }
                                    onClick={() => void reagir(m.id, e)}
                                    aria-pressed={posee}
                                    aria-label={posee ? `Retirer ${e}` : `Réagir avec ${e}`}
                                  >
                                    {e}
                                  </button>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
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
            : " "}
      </p>

      {sondage ? (
        <div className="forum-sondage-form">
          <p className="forum-sondage-titre">📊 Nouveau sondage</p>
          <input
            type="text"
            value={sondage.question}
            onChange={(e) => setSondage({ ...sondage, question: e.target.value })}
            placeholder="La question…"
            aria-label="Question du sondage"
            maxLength={MAX_FORUM_LEN}
          />
          {sondage.options.map((o, i) => (
            <input
              key={i}
              type="text"
              value={o}
              onChange={(e) =>
                setSondage({
                  ...sondage,
                  options: sondage.options.map((x, j) => (j === i ? e.target.value : x)),
                })
              }
              placeholder={`Réponse ${i + 1}`}
              aria-label={`Réponse ${i + 1}`}
              maxLength={MAX_POLL_OPTION_LEN}
            />
          ))}
          <div className="forum-sondage-actions">
            {sondage.options.length < MAX_POLL_OPTIONS && (
              <button
                type="button"
                className="secondary"
                onClick={() => setSondage({ ...sondage, options: [...sondage.options, ""] })}
              >
                + Réponse
              </button>
            )}
            <button type="button" className="secondary" onClick={() => setSondage(null)}>
              Annuler
            </button>
            <button
              type="button"
              onClick={() => void creerSondage()}
              disabled={
                envoi ||
                !sondage.question.trim() ||
                sondage.options.filter((o) => o.trim()).length < MIN_POLL_OPTIONS
              }
            >
              Publier
            </button>
          </div>
          {/* Dit avant le vote ce que le vote fera : plusieurs cases sont cochables, et le
              résultat n'est pas anonyme. */}
          <p className="forum-sondage-note">
            Chacun peut cocher plusieurs réponses, et voir qui a coché quoi.
          </p>
        </div>
      ) : (
        <>
          {citation && (
            <p className="forum-repond-a">
              <span>
                {/* `forumPreview` et non `slice` : c'était le SEUL endroit du domaine qui
                    coupait en unités UTF-16, alors que `forum.ts` énonce trois fois la règle
                    des points de code. Sans effet en base — le serveur ne lit pas cet extrait —
                    mais un « � » pouvait s'afficher, juste sous les yeux de celui qui rédige. */}
                Réponse à <strong>{citation.authorName}</strong> :{" "}
                {forumPreview(citation.body, 60)}
              </span>
              <button
                type="button"
                className="forum-action"
                onClick={() => setCitation(null)}
                aria-label="Annuler la réponse"
              >
                ✕
              </button>
            </p>
          )}
          {/* PAS DE `role="menu"`. Ce rôle est un CONTRAT : flèches directionnelles, tabindex
              roulant, piège de focus, Échap. Rien de tout cela n'était implémenté, et le
              `onKeyDown` qui ferme sur Échap était posé sur le `<form>` alors que la palette
              est rendue EN DEHORS — elle n'en recevait donc jamais l'événement. Un groupe de
              boutons ordinaires ne promet rien qu'il ne tienne : la tabulation les parcourt,
              Entrée et Espace les activent, et l'Échap ci-dessous est réellement branché. */}
          {paletteSaisie && (
            <div
              className="forum-palette"
              role="group"
              aria-label="Emoji"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setPaletteSaisie(false);
                  saisieRef.current?.focus();
                }
              }}
            >
              {FORUM_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => insererEmoji(e)}
                  aria-label={`Insérer ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          <form
            className="forum-form"
            onSubmit={(e) => {
              e.preventDefault();
              void envoyer();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPaletteSaisie(false);
            }}
          >
            <div className="forum-outils">
              <button
                type="button"
                className="secondary forum-outil"
                onClick={() => setPaletteSaisie((v) => !v)}
                aria-expanded={paletteSaisie}
                aria-label="Emoji"
              >
                😀
              </button>
              <button
                type="button"
                className="secondary forum-outil"
                onClick={() => setSondage({ question: "", options: ["", ""] })}
                aria-label="Créer un sondage"
              >
                📊
              </button>
            </div>
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
            {/* `restant < 0` DÉSACTIVE l'envoi. L'écran disait « Message trop long » et
                laissait partir quand même ; le serveur tronquait à 1000 et répondait 201, si
                bien qu'un compte rendu de 1300 caractères revenait coupé net dans le fil, sans
                ellipse, et son auteur croyait avoir tout envoyé. Le serveur refuse maintenant
                en 400 (cf. `parseForumBody`) — ce bouton est ce qui évite d'y arriver.

                Pas de `maxLength` sur le champ, à dessein : l'attribut compte des UNITÉS
                UTF-16 quand la limite du domaine compte des POINTS DE CODE. Le poser à 1000
                refuserait un message de 600 emoji que la limite autorise, en bloquant la
                frappe sans rien dire — la borne honnête est le compteur ci-dessous. */}
            <button
              type="submit"
              disabled={!draft.trim() || envoi || restant < 0}
              className="forum-envoi"
            >
              {envoi ? "…" : "Envoyer"}
            </button>
          </form>
        </>
      )}
      {restant < 100 && (
        <p className="forum-restant">
          {restant >= 0 ? `${restant} caractères restants` : "Message trop long"}
        </p>
      )}
      {/* LE COMPTEUR EST ANNONCÉ PAR PALIERS, pas à chaque touche. `aria-live` sur le texte
          ci-dessus faisait dire « 99… 98… 97… » en concurrence avec l'écho de la frappe :
          l'information utile — « tu approches de la limite » — se noyait dans son propre
          bruit. Ici la région ne change de contenu qu'à 100, 50, 20 et 0, donc le lecteur
          d'écran ne parle que quatre fois. Le texte visible, lui, reste continu. */}
      <p className="sr-only" aria-live="polite">
        {palierRestant}
      </p>
    </section>
  );
}
