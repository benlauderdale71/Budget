CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  email_verified_at text,
  mfa_secret text,
  mfa_enabled integer NOT NULL DEFAULT 0,
  recovery_hashes text NOT NULL DEFAULT '[]',
  locale text NOT NULL DEFAULT 'en-US',
  time_zone text NOT NULL DEFAULT 'America/Chicago',
  week_start integer NOT NULL DEFAULT 0,
  theme text NOT NULL DEFAULT 'system',
  privacy_mode integer NOT NULL DEFAULT 0,
  ai_enabled integer NOT NULL DEFAULT 1,
  pay_cadence text NOT NULL DEFAULT 'biweekly',
  budget_approach text NOT NULL DEFAULT 'zero',
  label_mode text NOT NULL DEFAULT 'categories',
  onboarding_step text,
  alert_settings text NOT NULL DEFAULT '{}',
  dashboard_layout text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  deleted_at text
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_label text,
  user_agent text,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text
);

CREATE TABLE IF NOT EXISTS households (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  currency text NOT NULL,
  budget_approach text NOT NULL,
  label_mode text NOT NULL DEFAULT 'categories',
  is_demo integer NOT NULL DEFAULT 0,
  time_zone text NOT NULL DEFAULT 'America/Chicago',
  week_start integer NOT NULL DEFAULT 0,
  member_limit integer,
  plan_revision integer NOT NULL DEFAULT 0,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE IF NOT EXISTS spaces (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  owner_user_id text,
  business_type text,
  currency text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL,
  expires_at text NOT NULL,
  accepted_at text,
  revoked_at text,
  reveal_summary text NOT NULL,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash ON invitations (token_hash);

CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  currency text NOT NULL,
  on_budget integer NOT NULL DEFAULT 0,
  visibility text NOT NULL DEFAULT 'shared',
  owner_user_id text,
  hidden integer NOT NULL DEFAULT 0,
  archived integer NOT NULL DEFAULT 0,
  exclude_from_net_worth integer NOT NULL DEFAULT 0,
  institution text,
  mask text,
  credit_limit_minor bigint,
  apr_bps integer,
  minimum_payment_minor bigint,
  linked_account_id text,
  display_order integer NOT NULL DEFAULT 0,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL,
  institution text,
  consent_at text,
  last_success_at text,
  error text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS buckets (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  group_name text NOT NULL,
  kind text NOT NULL,
  flex_role text NOT NULL,
  envelope_style text NOT NULL,
  rollover text NOT NULL,
  rollover_cap_minor bigint,
  icon text,
  archived integer NOT NULL DEFAULT 0,
  hidden integer NOT NULL DEFAULT 0,
  display_order integer NOT NULL DEFAULT 0,
  target_json text,
  system_role text,
  linked_account_id text,
  purpose text,
  due_day integer,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  date text NOT NULL,
  account_id text NOT NULL,
  counter_account_id text,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  type text NOT NULL,
  payee text NOT NULL,
  original_description text,
  bank_status text NOT NULL,
  review_status text NOT NULL,
  reviewer_user_id text,
  review_assigned_by text,
  review_assigned_at text,
  review_resolved_by text,
  review_resolved_at text,
  cleared integer NOT NULL DEFAULT 0,
  reconciled integer NOT NULL DEFAULT 0,
  locked integer NOT NULL DEFAULT 0,
  category_locked integer NOT NULL DEFAULT 0,
  flag text,
  notes text,
  check_number text,
  owner_user_id text,
  business_space_id text,
  project text,
  tax_code text,
  schedule_id text,
  refund_of_id text,
  import_batch_id text,
  provider_transaction_id text,
  client_op_id text,
  fx_json text,
  exclude_from_reports integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  deleted integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_provider_idx
  ON transactions (household_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL AND deleted = 0;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_client_op_idx
  ON transactions (household_id, client_op_id)
  WHERE client_op_id IS NOT NULL AND deleted = 0;

CREATE INDEX IF NOT EXISTS transactions_household_date_idx ON transactions (household_id, date);

CREATE TABLE IF NOT EXISTS splits (
  id text PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  bucket_id text,
  amount_minor bigint NOT NULL,
  role text NOT NULL,
  memo text,
  owner_user_id text,
  business_space_id text,
  project text,
  tax_code text
);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag text NOT NULL,
  PRIMARY KEY (transaction_id, tag)
);

CREATE TABLE IF NOT EXISTS assignments (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  bucket_id text NOT NULL,
  period_key text NOT NULL,
  amount_minor bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS assignments_unique ON assignments (space_id, bucket_id, period_key);

CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  name text NOT NULL,
  cadence text NOT NULL,
  custom_days integer,
  next_date text NOT NULL,
  amount_minor bigint NOT NULL,
  amount_max_minor bigint,
  direction text NOT NULL,
  account_id text,
  bucket_id text,
  type text NOT NULL,
  payee text,
  owner_user_id text,
  paused integer NOT NULL DEFAULT 0,
  trial_ends text,
  renewal_date text,
  reminder_days integer DEFAULT 3,
  fulfilled_through text,
  confirmed integer NOT NULL DEFAULT 1,
  detected integer NOT NULL DEFAULT 0,
  series_id text,
  skipped_dates text NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS plan_lines (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  bucket_id text NOT NULL,
  period_key text NOT NULL,
  planned_minor bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  bucket_id text,
  name text NOT NULL,
  target_minor bigint NOT NULL,
  target_date text,
  priority integer NOT NULL DEFAULT 1,
  purpose text,
  archived integer NOT NULL DEFAULT 0,
  notes text
);

CREATE TABLE IF NOT EXISTS holdings (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  symbol text NOT NULL,
  name text NOT NULL,
  asset_class text NOT NULL,
  sector text,
  geography text,
  quantity text NOT NULL,
  cost_basis_minor bigint,
  currency text NOT NULL
);

CREATE TABLE IF NOT EXISTS lots (
  id text PRIMARY KEY,
  holding_id text NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  quantity text NOT NULL,
  cost_basis_minor bigint,
  acquired text NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  price_minor bigint NOT NULL,
  as_of text NOT NULL,
  source text NOT NULL,
  delayed integer NOT NULL DEFAULT 1,
  currency text NOT NULL
);

CREATE TABLE IF NOT EXISTS valuations (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  date text NOT NULL,
  value_minor bigint NOT NULL,
  source text NOT NULL,
  note text
);

CREATE TABLE IF NOT EXISTS rules (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text,
  name text NOT NULL,
  priority integer NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  match_mode text NOT NULL,
  conditions_json text NOT NULL,
  actions_json text NOT NULL,
  stop integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watchlists (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text,
  name text NOT NULL,
  spec_json text NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  name text NOT NULL,
  adjustments_json text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  transaction_id text,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  storage_key text NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  ocr_json text
);

CREATE TABLE IF NOT EXISTS download_tokens (
  token_hash text PRIMARY KEY,
  attachment_id text NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  expires_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  user_id text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  household_id text,
  user_id text,
  action text NOT NULL,
  entity text,
  entity_id text,
  summary text NOT NULL,
  visibility text NOT NULL DEFAULT 'shared',
  owner_user_id text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  preview_json text NOT NULL,
  created_at text NOT NULL,
  committed_at text
);

CREATE TABLE IF NOT EXISTS applied_ops (
  household_id text NOT NULL,
  op_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (household_id, op_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at text NOT NULL,
  revoked_at text,
  last_used_at text
);

CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  user_id text,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  token_hash text NOT NULL,
  expires_at text NOT NULL,
  used_at text
);

CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  fingerprint text NOT NULL DEFAULT '',
  title text NOT NULL,
  body text NOT NULL,
  entity_type text,
  entity_id text,
  href text,
  amount_minor bigint,
  status text NOT NULL DEFAULT 'unread',
  snoozed_until text,
  resolved_at text,
  resolved_reason text,
  created_at text NOT NULL,
  updated_at text,
  read_at text,
  delivery_status text NOT NULL DEFAULT 'generated',
  delivery_detail text,
  last_notified_at text,
  escalated_at text,
  channel_status text NOT NULL DEFAULT '{}',
  channel text NOT NULL DEFAULT 'inapp'
);

CREATE TABLE IF NOT EXISTS alert_preferences (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  settings_json text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (user_id, household_id)
);

CREATE TABLE IF NOT EXISTS cases (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind text NOT NULL,
  merchant text NOT NULL,
  status text NOT NULL,
  authorized integer NOT NULL DEFAULT 0,
  details_json text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_entries (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  score integer,
  model text,
  bureau text,
  report_date text,
  source text NOT NULL,
  factors_json text NOT NULL DEFAULT '[]',
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  done integer NOT NULL DEFAULT 0,
  notes text,
  sort integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provider_events (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider text NOT NULL,
  kind text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  occurred_on text NOT NULL,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_events_external ON provider_events (household_id, provider, external_id);

CREATE TABLE IF NOT EXISTS oidc_states (
  state text PRIMARY KEY,
  user_id text,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_path text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS service_requests (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  detail text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name text NOT NULL,
  points_json text NOT NULL,
  source text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id text PRIMARY KEY,
  ticket_id text NOT NULL,
  user_id text NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL,
  email text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS assistant_actions (
  id text PRIMARY KEY,
  household_id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL,
  payload_json text NOT NULL,
  result_json text NOT NULL,
  undone_at text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  household_id text,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS education_progress (
  user_id text NOT NULL,
  lesson_id text NOT NULL,
  completed_at text NOT NULL,
  PRIMARY KEY (user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS transaction_matches (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  keeper_id text NOT NULL,
  archived_id text NOT NULL,
  provider_copied integer NOT NULL DEFAULT 0,
  moved_attachment_ids text NOT NULL DEFAULT '[]',
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS transaction_matches_archived_idx ON transaction_matches (archived_id);
CREATE UNIQUE INDEX IF NOT EXISTS transaction_matches_keeper_idx ON transaction_matches (keeper_id);

CREATE TABLE IF NOT EXISTS saved_views (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  query_json text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_archives (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  snapshot_json text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL,
  push_token text,
  created_at text NOT NULL,
  revoked_at text
);

CREATE TABLE IF NOT EXISTS consents (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  household_id text,
  provider text NOT NULL,
  scope text NOT NULL,
  granted_at text NOT NULL,
  withdrawn_at text
);

CREATE TABLE IF NOT EXISTS bucket_revisions (
  bucket_id text PRIMARY KEY REFERENCES buckets(id) ON DELETE CASCADE,
  household_id text NOT NULL,
  version integer NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS bucket_policies (
  id text PRIMARY KEY,
  household_id text NOT NULL,
  bucket_id text NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  effective_period text NOT NULL,
  rollover text NOT NULL,
  rollover_cap_minor bigint,
  created_at text NOT NULL,
  UNIQUE (bucket_id, effective_period)
);

CREATE TABLE IF NOT EXISTS fill_templates (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  name text NOT NULL,
  cadence text,
  custom_days integer,
  start_date text NOT NULL,
  end_date text,
  next_date text,
  time_zone text NOT NULL,
  paused integer NOT NULL DEFAULT 0,
  shortfall_policy text NOT NULL,
  sweep_bucket_id text,
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  archived integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS fill_lines (
  id text PRIMARY KEY,
  template_id text NOT NULL REFERENCES fill_templates(id) ON DELETE CASCADE,
  household_id text NOT NULL,
  bucket_id text NOT NULL,
  mode text NOT NULL,
  amount_minor bigint,
  percent_bps integer,
  priority integer NOT NULL,
  source_bucket_id text
);

CREATE TABLE IF NOT EXISTS fill_occurrences (
  id text PRIMARY KEY,
  template_id text NOT NULL,
  household_id text NOT NULL,
  occurrence_key text NOT NULL,
  status text NOT NULL,
  allocated_minor bigint NOT NULL DEFAULT 0,
  shortfall_minor bigint NOT NULL DEFAULT 0,
  detail_json text NOT NULL DEFAULT '{}',
  error text,
  attempt integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  finished_at text,
  UNIQUE (household_id, occurrence_key)
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id text PRIMARY KEY,
  household_id text NOT NULL,
  account_id text NOT NULL,
  date text NOT NULL,
  balance_minor bigint NOT NULL,
  source text NOT NULL
);

CREATE TABLE IF NOT EXISTS roadmap_order (
  household_id text NOT NULL,
  item_id text NOT NULL,
  label text NOT NULL,
  sort integer NOT NULL,
  PRIMARY KEY (household_id, item_id)
);

CREATE TABLE IF NOT EXISTS income_sources (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  owner_user_id text,
  account_id text NOT NULL,
  amount_minor bigint NOT NULL,
  amount_max_minor bigint,
  cadence text NOT NULL,
  custom_interval integer,
  anchor_day integer,
  twice_day_a integer,
  twice_day_b integer,
  start_date text NOT NULL,
  end_date text,
  paused integer NOT NULL DEFAULT 0,
  archived integer NOT NULL DEFAULT 0,
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS income_dates (
  source_id text NOT NULL REFERENCES income_sources(id) ON DELETE CASCADE,
  expected_date text NOT NULL,
  amount_minor bigint NOT NULL,
  amount_max_minor bigint,
  note text,
  PRIMARY KEY (source_id, expected_date)
);

CREATE TABLE IF NOT EXISTS income_exceptions (
  source_id text NOT NULL REFERENCES income_sources(id) ON DELETE CASCADE,
  exception_date text NOT NULL,
  PRIMARY KEY (source_id, exception_date)
);

CREATE TABLE IF NOT EXISTS income_occurrences (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES income_sources(id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  expected_date text NOT NULL,
  status text NOT NULL,
  expected_amount_minor bigint NOT NULL,
  revised_date text,
  revised_amount_minor bigint,
  received_date text,
  received_amount_minor bigint,
  remaining_minor bigint,
  delayed_until text,
  transaction_id text,
  extra_transaction_id text,
  note text,
  client_op_id text,
  settle_op_id text,
  scope text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (household_id, occurrence_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS income_occurrence_op_idx ON income_occurrences (household_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS income_occurrence_settle_idx ON income_occurrences (household_id, settle_op_id) WHERE settle_op_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS schedule_details (
  schedule_id text PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  anchor_day integer,
  twice_day_a integer,
  twice_day_b integer,
  custom_weeks integer,
  end_date text,
  exceptions_json text NOT NULL DEFAULT '[]',
  reserved integer NOT NULL DEFAULT 0,
  archived integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loan_scenarios (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  space_id text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  balance_minor bigint NOT NULL,
  balance_date text NOT NULL,
  apr_bps integer NOT NULL,
  payment_minor bigint NOT NULL,
  extra_minor bigint NOT NULL DEFAULT 0,
  start_date text NOT NULL,
  frequency text NOT NULL DEFAULT 'monthly',
  interest_method text NOT NULL DEFAULT 'monthly_nominal',
  refinance_json text,
  archived integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_by text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS loan_scenarios_household_idx ON loan_scenarios (household_id, archived);

CREATE TABLE IF NOT EXISTS loan_scenario_events (
  id text PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES loan_scenarios(id) ON DELETE CASCADE,
  month_index integer NOT NULL,
  extra_one_time_minor bigint,
  apr_bps integer,
  payment_minor bigint,
  holiday integer NOT NULL DEFAULT 0,
  label text
);

CREATE TABLE IF NOT EXISTS loan_scenario_audit (
  id text PRIMARY KEY,
  scenario_id text NOT NULL,
  household_id text NOT NULL,
  actor_id text,
  action text NOT NULL,
  detail text,
  version integer NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_states (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  step text NOT NULL,
  completed_json text NOT NULL DEFAULT '[]',
  skipped_json text NOT NULL DEFAULT '[]',
  draft_json text NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  finished_at text,
  updated_at text NOT NULL,
  PRIMARY KEY (user_id, household_id)
);

CREATE TABLE IF NOT EXISTS receipt_drafts (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  attachment_id text NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE CASCADE,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  engine text,
  source_kind text,
  raw_text text,
  fields_json text NOT NULL DEFAULT '{}',
  confidence double precision,
  confidence_note text,
  user_edited integer NOT NULL DEFAULT 0,
  transaction_id text,
  op_id text,
  error text,
  content_sha256 text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS receipt_drafts_hash ON receipt_drafts (household_id, content_sha256);

CREATE TABLE IF NOT EXISTS onboarding_keys (
  household_id text NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  setup_key text NOT NULL,
  resource_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (household_id, user_id, kind, setup_key)
);

CREATE TABLE IF NOT EXISTS provider_transaction_ids (
  household_id text NOT NULL,
  external_id text NOT NULL,
  transaction_id text NOT NULL,
  PRIMARY KEY (household_id, external_id)
);

CREATE TABLE IF NOT EXISTS oidc_pending (
  id text PRIMARY KEY,
  user_id text,
  token_hash text NOT NULL,
  purpose text NOT NULL,
  issuer text,
  subject text,
  email text,
  return_path text,
  expires_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  detail text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS message_enrollments (
  user_id text NOT NULL,
  channel text NOT NULL,
  consented_at text,
  opted_out_at text,
  destination_label text NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE IF NOT EXISTS learning_steps (
  user_id text NOT NULL,
  item_id text NOT NULL,
  kind text NOT NULL,
  step integer NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS support_attachments (
  id text PRIMARY KEY,
  ticket_id text NOT NULL,
  user_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL
);
