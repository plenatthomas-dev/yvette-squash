-- RETOUR ARRIÈRE du renumérotage des migrations (2026-08). À jouer AVANT de redéployer un
-- commit antérieur au renumérotage — revert, hotfix sur un ancien tag, ou déploiement d'une
-- branche qui n'a pas encore le renommage.
--
-- POURQUOI CE FICHIER EXISTE. Le renumérotage est sinon une porte à sens unique : une base
-- relabellisée en 01_…31_ face à un code qui porte encore 0_init…29_ fait voir à Prisma 31
-- migrations « pendantes ». Il rejoue alors 01_init sur une base peuplée, échoue sur
-- « relation "User" already exists » (P3018), et TOUS les déploiements suivants échouent
-- ensuite en P3009 jusqu'à une intervention manuelle. C'est exactement l'incident du
-- 2026-07-17. Ce script rend le retour possible sans intervention.
--
-- Mêmes garanties que l'aller : idempotent, sans effet sur une base vierge, incapable de créer
-- un doublon, et il échoue bruyamment plutôt que de laisser un état mixte.

DO $$
DECLARE
  paires CONSTANT text[][] := ARRAY[
    ['01_init', '0_init'],
    ['02_booking_unique', '1_booking_unique'],
    ['03_user_nickname', '2_user_nickname'],
    ['04_feedback_ratelimit', '3_feedback_ratelimit'],
    ['05_push_alerts', '3_push_alerts'],
    ['06_tricount', '4_tricount'],
    ['07_tricount_events', '5_tricount_events'],
    ['08_email_identity', '6_email_identity'],
    ['09_planning_snapshot', '7_planning_snapshot'],
    ['10_emailotp_ip', '8_emailotp_ip'],
    ['11_user_listed', '9_user_listed'],
    ['12_tricount_comments', '10_tricount_comments'],
    ['13_delegation', '11_delegation'],
    ['14_delegation_end_notified', '12_delegation_end_notified'],
    ['15_tricount_restrict_user_delete', '13_tricount_restrict_user_delete'],
    ['16_tournament', '14_tournament'],
    ['17_squashnet_ranking', '15_squashnet_ranking'],
    ['18_user_nickname_unique', '16_user_nickname_unique'],
    ['19_match_tier', '17_match_tier'],
    ['20_email_password', '18_email_password'],
    ['21_email_token_approved', '19_email_token_approved'],
    ['22_user_admin_mgmt', '20_user_admin_mgmt'],
    ['23_app_setting', '21_app_setting'],
    ['24_request_log_blocklist', '22_request_log_blocklist'],
    ['25_cron_run', '23_cron_run'],
    ['26_banner_dismissal', '24_banner_dismissal'],
    ['27_login_attempt_identifier', '25_login_attempt_identifier'],
    ['28_passkey', '26_passkey'],
    ['29_passkey_backup', '27_passkey_backup'],
    ['30_user_last_seen', '28_user_last_seen'],
    ['31_squashnet_rangm', '29_squashnet_rangm']
  ];
  i int;
  renommees int := 0;
  n int;
  restants int;
BEGIN
  IF to_regclass('"_prisma_migrations"') IS NULL THEN
    RAISE NOTICE 'retour renumerotation : _prisma_migrations absente, rien a faire';
    RETURN;
  END IF;

  FOR i IN 1 .. array_length(paires, 1) LOOP
    UPDATE "_prisma_migrations" m
       SET migration_name = paires[i][2]
     WHERE m.migration_name = paires[i][1]
       AND NOT EXISTS (
         SELECT 1 FROM "_prisma_migrations" d WHERE d.migration_name = paires[i][2]
       );
    GET DIAGNOSTICS n = ROW_COUNT;
    renommees := renommees + n;
  END LOOP;

  SELECT count(*) INTO restants FROM "_prisma_migrations"
   WHERE migration_name = ANY (ARRAY(SELECT paires[k][1] FROM generate_subscripts(paires, 1) AS k));
  IF restants > 0 THEN
    RAISE EXCEPTION
      'retour renumerotation : % ligne(s) portent encore le nouveau nom (doublon ?). Etat mixte, on refuse de continuer.',
      restants;
  END IF;

  RAISE NOTICE 'retour renumerotation : % ligne(s) remises a l ancien nom', renommees;
END $$;
