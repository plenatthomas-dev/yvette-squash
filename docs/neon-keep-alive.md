# Keep-alive Neon — garder la base chaude aux heures de réservation

## Le problème

La base Postgres (Neon, plan **Free**) applique un **scale-to-zero après 5 minutes
d'inactivité** — non désactivable sur le Free. Le premier accès après une mise en veille
paie un **cold start (~0,5–1 s)** le temps que le compute se réveille.

> Rappel : la lenteur historiquement ressentie ne venait PAS de ce cold start mais d'un
> **mismatch de région** (fonctions Vercel en `iad1` US ↔ Neon à Francfort), déjà corrigé
> par `regions: ["fra1"]` dans `vercel.json`. Le keep-alive ne traite que le cold start
> résiduel du premier hit après 5 min de calme.

## Pourquoi PAS un cron `vercel.json`

Le plan **Vercel Hobby limite les crons à 1 exécution par jour**. Une expression
sub-quotidienne (`*/4 …`, `0 * * * *`, etc.) **fait échouer le déploiement**
(`Hobby accounts are limited to daily cron jobs`). Les 4 crons applicatifs de `vercel.json`
sont d'ailleurs tous quotidiens/mensuels pour cette raison.

→ Le keep-alive doit donc venir d'un **cron externe**, pas de `vercel.json`.
**Ne jamais ajouter ce ping dans `vercel.json`** : ça casserait le build.

## Solution : cron-job.org → `/api/health`

`GET /api/health` fait exactement `SELECT 1` (réveille/maintient le compute), est **public**
(aucun secret à gérer) et déjà déployé. On le pingue **toutes les 4 minutes** (< 5 min, avec
60 s de marge avant la veille) pendant la **fenêtre du soir**.

### Réglages du job cron-job.org

| Champ | Valeur |
|---|---|
| **URL** | `https://squash-yvette.vercel.app/api/health` |
| **Method** | `GET` |
| **Expression cron** | `*/4 17-20 * * *` |
| **Timezone** | `Europe/Paris` ⚠️ (sinon UTC) |
| **Request timeout** | `30 s` |
| **Treat as success** | HTTP `200` uniquement |
| **Notifications** | email *on failure* (optionnel — repère une coupure de quota) |
| **Auth** | aucune (`/api/health` est public) |

### Fenêtre couverte

`*/4 17-20` → premier ping **17:00**, dernier **20:56** → base chaude de **17:00 à ~21:01**.
60 pings/jour, triviaux.

- Pour rester chaud **jusqu'à 22 h** : `*/4 17-21` (dernier ping 21:56, chaud → ~22:01).
- Pour pré-chauffer **avant 17 h** : `*/4 16-20` (chaud dès 16:00).

## Coût (plan Free = 100 CU-heures / mois / projet)

Neon facture le **compute allumé** (0,25 CU au minimum), **pas les pings** : tant que la base
ne retombe pas à zéro, elle est facturée en continu sur toute la fenêtre. Le nombre de pings
(et l'intervalle exact 4:00 vs 4:30) n'a **aucun** impact sur la conso — seule compte la durée
chaude. On garde 4:00 pour la marge de sécurité (60 s), pas pour le coût.

Fenêtre 17:00–21:00 = **4 h/jour** :

```
4 h/jour × 30,44 jours × 0,25 CU = ~30,4 CU-h/mois   (fenêtre seule)
+ crons du matin (~10) + trafic hors-fenêtre (~5)   ≈ ~45 CU-h/mois
```

**Marge : ~55 CU-h** sous les 100 gratuits. ✅

Pour mémoire, l'always-warm 24/7 coûterait ~182 CU-h/mois → **dépasse** le Free (base suspendue
en milieu de mois). C'est pourquoi on fenêtre.

## Mise en service

**Aucun redéploiement nécessaire** : `/api/health` est déjà en prod. Le keep-alive s'active
dès la **création du job sur cron-job.org** et se coupe dès sa suppression. Rien à changer côté
code ni `vercel.json`.
