// Garde-fou de débit compté en GESTES, pour les routes dont l'action EFFACE ce qu'elle écrit.
//
// POURQUOI CE MODULE EXISTE
// Le vote de sondage et la réaction du fil bornaient leur débit en comptant les lignes
// ENCORE PRÉSENTES créées dans la fenêtre (`ForumPollVote`, `ForumReaction`). Or ces deux
// actions sont des BASCULES : le vote efface toutes les cases du membre avant de reposer les
// siennes, la réaction se pose puis se retire. Un client qui boucle sur la même case ne laisse
// donc jamais plus d'une poignée de lignes vivantes — le compteur plafonnait à ~6 (vote) ou ~1
// (réaction) et le 429 ne partait JAMAIS. Le garde-fou existait pour protéger le quota
// JOURNALIER de Pusher (chaque geste diffuse un événement) : il ne protégeait rien.
//
// On compte donc le GESTE lui-même, dans un journal qui n'est jamais effacé par l'action :
// une ligne par geste accepté, comptée sur la fenêtre, purgée quand elle en sort.
//
// POURQUOI `LoginAttempt`, ET COMMENT ON Y COHABITE SANS RIEN CASSER
// Pas de migration pour un compteur : la table `LoginAttempt` est déjà un journal daté et
// indexé (`[identifier, createdAt]` sert exactement notre comptage), et elle accueille déjà
// des clés étrangères au login (`__passkey__` dans lib/webauthn.ts, `squashnet:…` dans la
// saisie fédérale du capitaine). Les trois lecteurs de la table ont été vérifiés :
//  - LE COMPTAGE ANTI-FORCE-BRUTE des connexions (api/auth/login, api/auth/email/login) filtre
//    `{ ip }` avec l'IP RÉELLE du client (`clientIp` rend une adresse ou `"local"`) et
//    `{ identifier }` avec un login ou un e-mail normalisé. Nos lignes portent `ip = GESTE_IP`
//    — ni une adresse, ni `"local"` — et un identifiant préfixé `forum-…:` qui ne peut pas être
//    un e-mail (pas d'arobase) ni un login ResaMania : aucune collision possible, dans aucun
//    sens. Une rafale de votes ne bloque jamais une connexion, et inversement.
//  - L'EFFACEMENT après une connexion réussie vise l'IP réelle et le login (en couple, ou l'un
//    OU l'autre selon les versions de ces routes) : mêmes valeurs réelles, donc il ne touche
//    jamais nos lignes, quelle que soit la forme retenue.
//  - LA PURGE des routes de login efface TOUTE ligne de plus de 15 min, nos gestes compris.
//    C'est sans conséquence tant que notre fenêtre ne dépasse pas ces 15 min : une ligne plus
//    vieille est de toute façon hors fenêtre. D'où `FENETRE_MAX_MS`, vérifié à l'appel — une
//    fenêtre plus longue serait silencieusement raccourcie par la purge d'un autre.

import { prisma } from "./db";

/** Valeur de la colonne `ip` de nos lignes : jamais une adresse réelle, jamais `"local"`. */
export const GESTE_IP = "geste";

/**
 * Fenêtre maximale acceptée : celle de la purge des routes de connexion (15 min). Au-delà, nos
 * lignes seraient effacées avant de sortir de la fenêtre et le plafond fuirait.
 */
export const FENETRE_MAX_MS = 15 * 60_000;

/**
 * Compte UN geste pour `cle` et dit s'il faut le REFUSER (plafond atteint sur la fenêtre).
 *
 * `cle` est préfixée par l'appelant (`forum-vote:${userId}`…) : c'est elle qui isole ce
 * compteur des autres occupants de `LoginAttempt`. Un geste refusé n'est PAS journalisé : le
 * client qui insiste ne repousse pas sa propre sortie de la fenêtre.
 *
 * Pas de transaction : deux gestes simultanés peuvent dépasser le plafond d'une unité. C'est un
 * garde-fou contre l'emballement, pas un quota comptable — un geste de plus ne coûte rien.
 */
export async function gesteRefuse(cle: string, fenetreMs: number, max: number): Promise<boolean> {
  if (fenetreMs > FENETRE_MAX_MS) {
    throw new Error(`Fenêtre de débit trop longue (${fenetreMs} ms > ${FENETRE_MAX_MS} ms)`);
  }
  const depuis = new Date(Date.now() - fenetreMs);
  // Purge opportuniste de NOS lignes sorties de la fenêtre (même forme que `passkeyRateLimited`) :
  // la table reste minuscule même si personne ne se connecte pendant des jours.
  //
  // `ip: GESTE_IP` DANS LES DEUX FILTRES, et pas par redondance : l'identifiant d'un échec de
  // connexion est ce que l'inconnu a TAPÉ. Quelqu'un qui saisirait « forum-vote:<id d'un
  // membre> » comme login écrirait, à chaque échec, une ligne de notre clé — et viendrait
  // remplir le compteur d'un autre. Ces lignes-là portent son IP réelle : on les ignore.
  await prisma.loginAttempt.deleteMany({
    where: { ip: GESTE_IP, identifier: cle, createdAt: { lt: depuis } },
  });
  const recents = await prisma.loginAttempt.count({
    where: { ip: GESTE_IP, identifier: cle, createdAt: { gte: depuis } },
  });
  if (recents >= max) return true;
  await prisma.loginAttempt.create({ data: { ip: GESTE_IP, identifier: cle } });
  return false;
}
