import type {
  BookResult,
  Court,
  PlanningDay,
  ResaCredentials,
  ResaIdentity,
  ResaSession,
  Slot,
} from "./types";
import { mockPlanning } from "./mock";
import { toInstant } from "@/lib/time";

/**
 * ============================================================================
 *  ADAPTATEUR RESAMANIA — point unique de contact avec l'API interne.
 *  Rétro-ingénierie validée en live (login OAuth2 + planning + réservation).
 * ============================================================================
 */

const API = process.env.RESA_API_BASE_URL ?? "https://api.resamania.com";
const TENANT = process.env.RESA_TENANT ?? "lecomplexbures";
const CLUB_ID = process.env.RESA_CLUB_ID ?? "/lecomplexbures/clubs/2345";
const ACTIVITY_ID =
  process.env.RESA_ACTIVITY_ID ?? "/lecomplexbures/activities/30592";
const CLIENT_ID = process.env.RESA_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.RESA_CLIENT_SECRET ?? "";
const REDIRECT_URI =
  process.env.RESA_REDIRECT_URI ??
  "https://member.resamania.com/lecomplexbures/";
const USE_MOCK = process.env.RESA_USE_MOCK === "1";

const AUTH_QS = `client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
  REDIRECT_URI,
)}&response_type=code`;

// ----------------------------------------------------------------------------
//  Cookie jar minimal (le flux OAuth pose un cookie resa2_oauth qu'il faut garder)
// ----------------------------------------------------------------------------
class CookieJar {
  private jar = new Map<string, string>();
  absorb(res: Response) {
    const list: string[] = res.headers.getSetCookie?.() ?? [];
    for (const sc of list) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get size() {
    return this.jar.size;
  }
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("access_token n'est pas un JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

// ----------------------------------------------------------------------------
//  LOGIN — OAuth2 authorization_code (login Symfony en 2 étapes)
// ----------------------------------------------------------------------------
export async function login(creds: ResaCredentials): Promise<ResaSession> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("RESA_CLIENT_ID / RESA_CLIENT_SECRET manquants dans .env");
  }
  const jar = new CookieJar();
  const form = (body: string) =>
    ({
      method: "POST",
      redirect: "manual" as const,
      headers: {
        cookie: jar.header(),
        "content-type": "application/x-www-form-urlencoded",
        accept: "*/*",
      },
      body,
    });

  // 1) page de login -> cookie de session
  jar.absorb(
    await fetch(`${API}/oauth/login/${TENANT}?${AUTH_QS}&locale=fr`, {
      redirect: "manual",
      headers: { accept: "*/*" },
    }),
  );

  // 2) étape identifiant
  jar.absorb(
    await fetch(
      `${API}/oauth/login/${TENANT}?${AUTH_QS}&locale=fr`,
      form(`login_step_login[username]=${encodeURIComponent(creds.username)}`),
    ),
  );

  // 3) étape mot de passe (login_check)
  const r3 = await fetch(
    `${API}/${TENANT}/oauth/login_check?${AUTH_QS}`,
    form(
      `_username=${encodeURIComponent(creds.username)}&_password=${encodeURIComponent(
        creds.password,
      )}`,
    ),
  );
  jar.absorb(r3);

  // 4) suivre les redirections jusqu'au code d'autorisation
  let loc = r3.headers.get("location");
  let code: string | null = null;
  for (let hop = 0; loc && hop < 6; hop++) {
    const m = loc.match(/[?&]code=([^&]+)/);
    if (m) {
      code = m[1];
      break;
    }
    const u = loc.startsWith("http") ? loc : API + loc;
    const r = await fetch(u, {
      redirect: "manual",
      headers: { cookie: jar.header(), accept: "*/*" },
    });
    jar.absorb(r);
    loc = r.headers.get("location");
  }
  if (!code) {
    throw new Error("Identifiants invalides ou flux de connexion interrompu.");
  }

  // 5) échange code -> token
  const session = await exchangeToken(
    `grant_type=authorization_code&client_id=${CLIENT_ID}&client_secret=${encodeURIComponent(
      CLIENT_SECRET,
    )}&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  );
  return session;
}

async function exchangeToken(body: string): Promise<ResaSession> {
  const res = await fetch(`${API}/${TENANT}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Échange de token échoué (${res.status})`);
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const identity = await resolveIdentity(tok.access_token);
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in - 60) * 1000, // marge de 60 s
    identity,
  };
}

/** Rafraîchit la session si le token a (presque) expiré. */
export async function ensureFresh(session: ResaSession): Promise<ResaSession> {
  if (Date.now() < session.expiresAt) return session;
  const refreshed = await exchangeToken(
    `grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${encodeURIComponent(
      CLIENT_SECRET,
    )}&refresh_token=${encodeURIComponent(session.refreshToken)}`,
  );
  return refreshed;
}

/** Déduit l'identité (contactId, etc.) à partir du JWT + d'un appel /contact_users. */
async function resolveIdentity(accessToken: string): Promise<ResaIdentity> {
  const claims = decodeJwt(accessToken) as {
    userId?: string;
    targetId?: string;
    clubId?: string;
    email?: string;
    familyName?: string;
    givenName?: string;
  };
  const contactUserId =
    claims.userId ?? String(claims.targetId ?? "").split("/").pop() ?? "";
  const cu = await apiGet<{
    contactId: string;
    familyName: string;
    givenName: string;
    email: string;
    createdAt: string;
  }>(`/contact_users/${contactUserId}`, accessToken);
  const contactNum = cu.contactId.split("/").pop();
  return {
    contactUserId,
    contactId: cu.contactId,
    contactNumber: `C${contactNum}`,
    clubId: claims.clubId ?? CLUB_ID,
    familyName: cu.familyName,
    givenName: cu.givenName,
    email: cu.email ?? claims.email ?? "",
    contactCreatedAt: cu.createdAt,
  };
}

// ----------------------------------------------------------------------------
//  Helpers API authentifiés (Bearer)
// ----------------------------------------------------------------------------
async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}/${TENANT}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// Cache des noms de courts (studios). On demande du ld+json pour obtenir les @id (IRI),
// que le format json simple omet.
let studiosCache: { iri: string; name: string }[] | null = null;
async function getStudios(token: string): Promise<Map<string, string>> {
  if (!studiosCache) {
    const res = await fetch(
      `${API}/${TENANT}/studios?club=${encodeURIComponent(CLUB_ID)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/ld+json",
        },
      },
    );
    // Ne JAMAIS mettre en cache un échec ou un résultat vide : sinon `[]` (qui n'est pas
    // null) reste en cache pour toute la durée de vie de l'instance serverless, et tous
    // les noms de terrains retombent sur leur ID numérique brut (ex. « 5382 »). On renvoie
    // une map vide pour CET appel (le planning s'affiche quand même) et on réessaiera au
    // prochain — auto-guérison dès que /studios répond à nouveau correctement.
    if (!res.ok) return new Map();
    const data = (await res.json()) as {
      "hydra:member"?: Array<{ "@id": string; name: string }>;
    };
    const members = data["hydra:member"] ?? [];
    if (members.length === 0) return new Map();
    studiosCache = members.map((s) => ({
      iri: s["@id"],
      name: s.name,
    }));
  }
  return new Map(studiosCache.map((s) => [s.iri, s.name]));
}

// ----------------------------------------------------------------------------
//  PLANNING
// ----------------------------------------------------------------------------
type RawEvent = {
  "@id": string;
  studio: string;
  startedAt: string;
  endedAt: string;
  attendeeRemaining: number;
  attendingLimit: number;
  bookedAttendees?: Array<{ contactId?: string }>;
};

export async function getPlanning(
  date: string,
  accessToken?: string,
): Promise<PlanningDay> {
  if (USE_MOCK || !accessToken) {
    return mockPlanning(date, CLUB_ID);
  }

  const studios = await getStudios(accessToken);
  const params = new URLSearchParams();
  params.set("club", CLUB_ID);
  params.set("activity", ACTIVITY_ID);
  params.set("order[startedAt]", "asc");
  params.set("startedAt[after]", `${date}T00:00:00`);
  params.set("startedAt[before]", `${date}T23:59:59`);
  params.set("itemsPerPage", "300");

  // On demande du ld+json : le json simple omet le champ @id (l'IRI), indispensable pour réserver.
  const res = await fetch(`${API}/${TENANT}/class_events?${params}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/ld+json",
    },
  });
  if (!res.ok) throw new Error(`Planning indisponible (${res.status})`);
  const json = (await res.json()) as {
    "hydra:member"?: RawEvent[];
  };
  const events: RawEvent[] = Array.isArray(json)
    ? json
    : (json["hydra:member"] ?? []);

  const slots: Slot[] = events.map((e) => {
    const free = e.attendeeRemaining > 0;
    return {
      id: e["@id"],
      courtId: e.studio,
      courtName: studios.get(e.studio) ?? e.studio.split("/").pop() ?? "?",
      // ResaMania renvoie une heure murale sans fuseau → on la fige en instant absolu
      // (interprétée comme heure du club), sinon décalage selon où tourne le code.
      startsAt: toInstant(e.startedAt),
      endsAt: toInstant(e.endedAt),
      status: free ? "free" : "booked",
      bookable: free,
      remaining: e.attendeeRemaining,
      bookerContactId: e.bookedAttendees?.[0]?.contactId ?? null,
    };
  });

  // courts = studios présents ce jour-là, triés par nom
  const courtMap = new Map<string, Court>();
  for (const s of slots)
    if (!courtMap.has(s.courtId))
      courtMap.set(s.courtId, { id: s.courtId, name: s.courtName });
  const courts = [...courtMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return { date, clubId: CLUB_ID, courts, slots };
}

// ----------------------------------------------------------------------------
//  RÉSERVATION
// ----------------------------------------------------------------------------
export async function book(
  session: ResaSession,
  classEventIri: string,
): Promise<BookResult> {
  const id = session.identity;
  const payload = {
    contactId: id.contactId,
    contactClubId: id.clubId,
    contactNumber: id.contactNumber,
    contactFamilyName: id.familyName,
    contactGivenName: id.givenName,
    contactCreatedAt: id.contactCreatedAt,
    classEvent: classEventIri,
  };
  const res = await fetch(`${API}/${TENANT}/attendees`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
      // ld+json : sinon la réponse 201 omet @id (l'IRI de l'attendee, requis pour annuler)
      accept: "application/ld+json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 201) {
    let msg = `Réservation refusée (${res.status})`;
    try {
      const j = (await res.json()) as {
        "hydra:description"?: string;
        detail?: string;
      };
      msg = j["hydra:description"] || j.detail || msg;
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg };
  }
  const j = (await res.json()) as { "@id": string; state: string };
  return { ok: true, attendeeId: j["@id"], state: j.state };
}

/**
 * Retrouve l'IRI de l'attendee du joueur courant pour un class_event donné.
 * Sert de rattrapage pour annuler une résa dont on n'aurait pas mémorisé l'attendeeId.
 */
export async function findAttendeeId(
  session: ResaSession,
  classEventIri: string,
): Promise<string | null> {
  const res = await fetch(
    `${API}/${TENANT}/attendees?classEvent=${encodeURIComponent(classEventIri)}`,
    {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/ld+json",
      },
    },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as {
    "hydra:member"?: Array<{ "@id": string; contactId?: string; state?: string }>;
  };
  // ResaMania conserve l'HISTORIQUE des attendees : après plusieurs cycles résa/annulation
  // sur le même créneau, plusieurs lignes coexistent pour le même contact (des "canceled"
  // + au plus une active). On IGNORE les annulées, sinon on retomberait sur une ligne déjà
  // "canceled" et l'annulation renverrait 400 (prohibited-transition cancel <- canceled).
  const mine = (j["hydra:member"] ?? []).filter(
    (a) => a.contactId === session.identity.contactId && a.state !== "canceled",
  );
  // Au plus une résa active par créneau ; en cas d'ambiguïté on prend la dernière.
  return mine.length ? mine[mine.length - 1]["@id"] : null;
}

export async function cancel(
  session: ResaSession,
  attendeeIri: string,
): Promise<BookResult> {
  // attendeeIri = "/lecomplexbures/attendees/116343527"
  // L'annulation n'est PAS un DELETE (⇒ 403) : c'est une transition de machine à états
  // (workflow Symfony). POST /attendees/{id}/transitions {"transition":"cancel"} → 201, state="canceled".
  const res = await fetch(`${API}${attendeeIri}/transitions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
      // ld+json : API Platform renvoie alors le motif du refus dans hydra:description
      accept: "application/ld+json",
    },
    body: JSON.stringify({ transition: "cancel" }),
  });
  if (res.status >= 200 && res.status < 300) {
    let state: string | undefined;
    try {
      state = ((await res.json()) as { state?: string }).state;
    } catch {
      /* corps illisible : la transition a réussi malgré tout (2xx) */
    }
    return { ok: true, state };
  }

  // On fait remonter le vrai motif renvoyé par ResaMania (ex. délai d'annulation dépassé)
  let msg = `Annulation refusée (${res.status})`;
  try {
    const j = (await res.json()) as {
      "hydra:description"?: string;
      detail?: string;
      message?: string;
    };
    const detail = j["hydra:description"] || j.detail || j.message;
    if (detail) msg = `${detail} (${res.status})`;
  } catch {
    /* corps non-JSON : on garde le message générique */
  }
  return { ok: false, error: msg };
}
