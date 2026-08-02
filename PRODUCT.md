# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Public principal — les joueurs du club.** Adhérents du Squash de l'Yvette (Le Complexe,
Bures), d'âges variés, majoritairement sur téléphone. Situation type : décider vite s'il reste
un terrain libre à un créneau donné, puis réserver, souvent dans un moment court (au bureau, en
chemin, au bord du terrain). Beaucoup ne sont pas technophiles.

**Public secondaire — le bureau / l'admin.** Une à deux personnes qui valident les demandes
d'inscription, modèrent (blocklist), publient des annonces, pilotent les fonctions à chaud et
peuvent fermer l'appli. C'est un public à part entière, pas un rôle accessoire : il a ses
propres écrans (`/admin`, `/admin/membres`, `/admin/demandes`, `/admin/tricounts`).

**État confirmé : produit EN TRANSITION.** Parti d'un usage entre amis (ce que dit encore le
README), il s'ouvre progressivement à l'ensemble du club. Les deux logiques cohabitent
aujourd'hui, et chaque surface doit tenir pour les deux : un habitué pressé qui veut de la
densité et des raccourcis, et un nouveau membre à qui rien ne doit devoir être expliqué.
L'onboarding doit donc être progressif, jamais bloquant. Les flags `NEXT_PUBLIC_FEATURE_*`
servent précisément à doser cette ouverture.

## Product Purpose

Poser un planning lisible et une réservation en un tap **au-dessus** de ResaMania, le logiciel
de réservation du complexe, puis y greffer ce qui fait la vie du club et que ResaMania ne
couvre pas.

Réussite = un membre obtient la réponse à « est-ce qu'il y a un terrain ce soir ? » en un coup
d'œil, et réserve sans quitter l'appli.

## Positioning

Quatre apports confirmés, qu'un logiciel de réservation générique ne peut pas revendiquer :

1. **Lisibilité immédiate.** La grille terrains × horaires répond d'un regard, là où ResaMania
   oblige à naviguer. C'est le cœur du produit.
2. **Couche sociale.** Journal partagé « qui a réservé quoi », annuaire des membres, présences
   sur un créneau, classement fédéral. ResaMania ne montre pas les autres membres.
3. **Alertes terrain libéré.** Notification push quand un créneau convoité se libère —
   ResaMania n'a pas de liste d'attente, c'est structurellement hors de sa portée.
4. **La vie de club autour du jeu.** Frais partagés, tournois internes, délégation de droits :
   des usages du club, hors du périmètre d'un logiciel de réservation.

## Operating Context

- **Usage mobile dominant**, en PWA installable (écran d'accueil, plein écran). Le desktop est
  servi aussi, mais n'est pas la scène principale.
- **Moments courts et décisions rapides** : la consultation précède presque toujours l'action.
- **ResaMania est l'amont** : chaque joueur agit avec SON propre compte ResaMania ; l'appli ne
  crée pas de réservation « au nom du club ».
- **Notifications** : web push (VAPID) + service worker, avec relais sonore quand l'appli est
  ouverte.
- **Rythme associatif** : pas d'astreinte, pas de support. Ce qui casse doit rester
  compréhensible par le membre sans intervention humaine.

## Capabilities and Constraints

**Capacités confirmées** (plusieurs sont pilotées par des flags `NEXT_PUBLIC_FEATURE_*`, dont
le défaut d'environnement est surchargeable à chaud depuis `/admin`) : planning et réservation
(simple et groupée), annulation, journal des réservations, présences sur créneau, alertes
terrain libéré, frais partagés (« Tricount ») avec commentaires, annuaire des membres, tournois
internes, classement fédéral (source publique squashnet.fr), délégation temporaire de droits,
annonces (push, bannière, modale), espace d'administration, blocage de l'appli aux membres.

**Authentification** : compte ResaMania (principal), connexion « email seul » (lecture seule,
sans réservation), passkeys / biométrie. Sessions de 30 jours. Droits d'admin par allowlist
d'e-mails en variable d'environnement (`ADMIN_EMAILS`), sans UI de gestion — choix assumé pour
une petite association, avec défaut « fail-safe » : liste vide ⇒ personne n'est admin.

**Contraintes durables à ne jamais casser** (confirmées) :

- **Rester dans les paliers gratuits.** Neon (100 CU-h/mois, mise en veille après 5 min
  d'inactivité) et Vercel Hobby (crons quotidiens uniquement). Conséquences de conception, pas
  détails d'infra : pas de polling client agressif, pas de requête base ajoutée sur un chemin
  chaud, toute fonction périodique se juge à son coût de réveil de la base.
- **Utilisable par des non-technophiles.** Rien ne doit exiger d'explication.
- **Le tutoiement et le ton actuel.** L'interface tutoie et parle simplement (« Connecte-toi »,
  « Réessaie dans quelques minutes »). Aucun glissement vers un ton corporate.
- **La dépendance ResaMania reste discrète.** L'appli automatise l'API **interne** de
  ResaMania, non officielle : elle peut casser sans préavis et son usage peut contrevenir aux
  CGU. L'UI ne doit ni exposer cette plomberie au-delà du strict nécessaire (les identifiants
  du membre), ni enfermer davantage le produit dedans.

**Contraintes techniques héritées** : région `fra1` imposée (les fonctions doivent être
colocalisées avec la base à Francfort — un mismatch de région avait été la vraie cause d'une
lenteur historique) ; CSP stricte à nonce avec `strict-dynamic` (toute injection de script
demande une modification de source explicite).

**Explicitement non décidé** : le devenir du cadre juridique vis-à-vis des CGU ResaMania. À ne
pas trancher à la place de l'utilisateur, et à ne pas présenter comme réglé.

## Brand Commitments

- **Nom** : « Squash de l'Yvette » (`short_name` : « Squash Yvette »).
- **Logo** : `public/logo_squash.jpeg`, sur fond blanc, affiché en `.logo-hero` à la même place
  et à la même taille sur l'écran de chargement et l'écran de connexion — cette continuité est
  volontaire, le logo ne doit pas bouger d'un écran à l'autre.
- **Voix** : français, tutoiement, phrases courtes, emojis ponctuels et fonctionnels
  (« Biométrie reconnue ✅ »). Contrainte confirmée comme binding.
- **Thème** : clair et sombre tous deux pris en charge ; `theme_color` `#0f1115`.

## Evidence on Hand

- **Produit réellement en production** : `squash-yvette.vercel.app`, avec de vrais membres.
- **Captures** : `public/screenshot-wide.png` (2560×1600), `public/screenshot-mobile.png`
  (780×1688) — déjà utilisées par la PWA install UI de Chrome.
- **Documentation interne** : `docs/flux-branches.md`, `docs/neon-keep-alive.md`,
  `docs/delegation-droits.md`, `docs/biometrie.md`, `docs/idees-developpement.md`.
- **Suite de tests** : 345 tests vitest au vert.
- **Absences à ne jamais fabriquer** : aucun témoignage, aucun client, aucune tarification,
  aucun chiffre d'audience, aucun partenariat avec ResaMania. C'est un outil associatif
  gratuit ; toute preuve sociale devra venir de l'utilisateur.

## Product Principles

1. **La grille est le produit.** Toute décision se juge d'abord à « répond-elle plus vite à
   *un terrain ce soir ?* ». Ce qui encombre la lecture du planning coûte plus qu'il ne rapporte.
2. **Deux publics, une seule surface.** Chaque écran doit tenir pour l'habitué pressé et pour
   le nouveau membre non-technophile — par la progressivité, pas par deux parcours séparés.
3. **Le coût d'hébergement est une contrainte de conception.** Une fonction qui réveille la
   base en continu n'est pas « un détail d'infra » : elle menace la gratuité, donc l'existence
   du service.
4. **La plomberie ne remonte pas à la surface.** ResaMania n'apparaît que là où le membre doit
   agir. Une panne amont se présente en français clair, jamais en message technique.
5. **Fermer plutôt que mentir.** Quand le service ne peut pas rendre le service, il le dit
   explicitement (bannière de maintenance, blocage volontaire) au lieu d'échouer en silence.

## Accessibility & Inclusion

Besoin produit confirmé : membres d'âges variés, non-technophiles, souvent pressés et sur
petit écran. L'interface doit rester utilisable sans explication préalable.

Acquis déjà présents dans le code, à préserver : lien d'évitement vers le contenu, textes
`sr-only`, régions `aria-live` sur les messages d'état, `role="switch"` sur les interrupteurs,
respect de `prefers-reduced-motion`, messages d'erreur rédigés en français courant.

Aucun standard formel (WCAG niveau X) n'a été établi comme exigence — à ne pas inventer.
