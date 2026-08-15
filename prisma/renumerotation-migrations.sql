-- Relabellisation de `_prisma_migrations` après le renumérotage des dossiers (2026-08).
--
-- POURQUOI. Les dossiers n'étaient pas numérotés à largeur fixe : Prisma les applique dans
-- l'ordre du nom de dossier trié par localeCompare, où « 10_ » passe avant « 2_ ». Aucune base
-- vierge ne pouvait donc être construite depuis le dépôt, et ce défaut a DÉJÀ cassé un déploiement
-- de production le 2026-07-17 (cf. commit 0003380). Dossiers désormais préfixés 01_ à 31_.
--
-- POURQUOI C'EST AUTOMATIQUE. Les anciens noms sont enregistrés dans les bases existantes. Une
-- procédure manuelle « à lancer avant de déployer » aurait été un piège : le build Vercel joue
-- `prisma migrate deploy` à CHAQUE déploiement, preview comprise. L'oublier une fois, et Prisma
-- considère les 31 migrations comme pendantes, rejoue `01_init` sur une base peuplée, échoue sur
-- « relation "User" already exists », puis refuse tout déploiement ultérieur jusqu'à une
-- intervention humaine (`migrate resolve --rolled-back`). Ce fichier est donc joué par le script
-- `db:deploy:retry`, AVANT `migrate deploy`, sur chaque environnement et sans geste humain.
--
-- SÛRETÉ. Le script est idempotent et ne peut pas créer de doublon :
--   • il ne fait rien si la table n'existe pas encore (base vierge : `migrate deploy` créera
--     directement les bons noms) ;
--   • chaque renommage est conditionné à l'absence du nouveau nom ;
--   • les noms complets étant uniques par leur suffixe, l'ordre des UPDATE est indifférent ;
--   • une ligne orpheline hors mapping est laissée telle quelle — la production en porte une,
--     `10_passkey_backup`, proprement annulée (`rolled_back_at` non nul, 0 étape appliquée),
--     vestige de l'incident du 2026-07-17. Prisma l'ignore, on n'y touche pas.
--
-- Vérifié le 2026-08-15 sur l'historique réel de production (32 lignes, lecture seule via
-- neonctl) et répété à blanc sur Postgres 16.

DO $$
DECLARE
  paires CONSTANT text[][] := ARRAY[
    ['0_init',                          '01_init'],
    ['1_booking_unique',                '02_booking_unique'],
    ['2_user_nickname',                 '03_user_nickname'],
    ['3_feedback_ratelimit',            '04_feedback_ratelimit'],
    ['3_push_alerts',                   '05_push_alerts'],
    ['4_tricount',                      '06_tricount'],
    ['5_tricount_events',               '07_tricount_events'],
    ['6_email_identity',                '08_email_identity'],
    ['7_planning_snapshot',             '09_planning_snapshot'],
    ['8_emailotp_ip',                   '10_emailotp_ip'],
    ['9_user_listed',                   '11_user_listed'],
    ['10_tricount_comments',            '12_tricount_comments'],
    ['11_delegation',                   '13_delegation'],
    ['12_delegation_end_notified',      '14_delegation_end_notified'],
    ['13_tricount_restrict_user_delete','15_tricount_restrict_user_delete'],
    ['14_tournament',                   '16_tournament'],
    ['15_squashnet_ranking',            '17_squashnet_ranking'],
    ['16_user_nickname_unique',         '18_user_nickname_unique'],
    ['17_match_tier',                   '19_match_tier'],
    ['18_email_password',               '20_email_password'],
    ['19_email_token_approved',         '21_email_token_approved'],
    ['20_user_admin_mgmt',              '22_user_admin_mgmt'],
    ['21_app_setting',                  '23_app_setting'],
    ['22_request_log_blocklist',        '24_request_log_blocklist'],
    ['23_cron_run',                     '25_cron_run'],
    ['24_banner_dismissal',             '26_banner_dismissal'],
    ['25_login_attempt_identifier',     '27_login_attempt_identifier'],
    ['26_passkey',                      '28_passkey'],
    ['27_passkey_backup',               '29_passkey_backup'],
    ['28_user_last_seen',               '30_user_last_seen'],
    ['29_squashnet_rangm',              '31_squashnet_rangm']
  ];
  i int;
  renommees int := 0;
  n int;
  total int;
  attendus int;
  restants int;
BEGIN
  -- Base vierge : rien à relabelliser, `migrate deploy` posera directement les bons noms.
  -- Nom NON qualifié à dessein : on suit le `search_path` de la connexion, comme les UPDATE
  -- plus bas. Un `public.` en dur ici mentirait si l'environnement pointait un autre schéma —
  -- le script conclurait « base vierge » puis `migrate deploy` rejouerait tout sur une base
  -- peuplée.
  IF to_regclass('"_prisma_migrations"') IS NULL THEN
    RAISE NOTICE 'renumerotation : _prisma_migrations absente, rien a faire (base vierge)';
    RETURN;
  END IF;

  FOR i IN 1 .. array_length(paires, 1) LOOP
    -- La condition NOT EXISTS rend l'opération rejouable : au 2e passage, le nouveau nom est
    -- déjà là et l'UPDATE ne touche rien.
    UPDATE "_prisma_migrations" m
       SET migration_name = paires[i][2]
     WHERE m.migration_name = paires[i][1]
       AND NOT EXISTS (
         SELECT 1 FROM "_prisma_migrations" d WHERE d.migration_name = paires[i][2]
       );
    GET DIAGNOSTICS n = ROW_COUNT;
    renommees := renommees + n;
  END LOOP;

  -- CONTRÔLE BLOQUANT. `prisma db execute` ne remonte pas les RAISE NOTICE : un simple message
  -- passerait inaperçu et l'anomalie ne se manifesterait qu'à l'étape suivante, sous la forme
  -- d'un P3018 sans rapport apparent. On lève donc une exception, qui elle fait échouer le
  -- build AVANT `migrate deploy` — un déploiement qui ne part pas vaut mieux qu'un historique
  -- de migrations empoisonné, dont la sortie exige une intervention humaine.
  SELECT count(*) INTO total FROM "_prisma_migrations";
  IF total = 0 THEN
    RAISE NOTICE 'renumerotation : historique vide, rien a faire';
    RETURN;
  END IF;

  SELECT count(*) INTO attendus FROM "_prisma_migrations"
   WHERE migration_name = ANY (ARRAY(SELECT paires[k][2] FROM generate_subscripts(paires, 1) AS k));
  SELECT count(*) INTO restants FROM "_prisma_migrations"
   WHERE migration_name = ANY (ARRAY(SELECT paires[k][1] FROM generate_subscripts(paires, 1) AS k));

  IF restants > 0 THEN
    -- Cas typique : un deploiement d'un code d'AVANT le renumerotage a tourne entre-temps et a
    -- laisse une ligne a l'ancien nom (souvent en echec) a cote de la nouvelle. Le NOT EXISTS
    -- ci-dessus a donc refuse de renommer. Le message doit dire quoi faire, pas seulement que
    -- ca coince : sans ca, on cherche a l'aveugle sur une prod bloquee.
    RAISE EXCEPTION
      'renumerotation : % ligne(s) portent ENCORE un ancien nom alors que le nouveau existe deja. Cause probable : un deploiement d''un commit anterieur au renumerotage. A faire : verifier "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at", supprimer/annuler la ligne en double a l''ancien nom (prisma migrate resolve --rolled-back <nom>), puis relancer. Pour repartir sur l''ancienne numerotation : npm run db:renumerote:retour.',
      restants;
  END IF;

  IF attendus = 0 THEN
    RAISE EXCEPTION
      'renumerotation : % ligne(s) presentes mais aucune ne correspond aux migrations connues. Base inattendue, on refuse de continuer.',
      total;
  END IF;

  RAISE NOTICE 'renumerotation : % relabellisee(s), % ligne(s) conformes sur % au total',
    renommees, attendus, total;
END $$;
