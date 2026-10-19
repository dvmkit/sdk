-- Run with psql -X -q -t -A -v ON_ERROR_STOP=1 -f financial-export-v1.sql > financial-evidence.json
-- The transaction gives every table one consistent snapshot. Optional rail tables
-- absent from this service are empty arrays. Keep this file with the export.
-- Receipts are signed over every field. Reject unsupported shapes instead of
-- removing signed extensions and silently producing unverifiable evidence.
CREATE OR REPLACE FUNCTION pg_temp.receipt_v1(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE allowed text[]; nested_allowed text[]; item record; nested_item record;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN RETURN value; END IF;
  IF jsonb_typeof(value) <> 'object' OR value->'v' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'financial export v1: unsupported receipt version or shape';
  END IF;
  CASE value->>'kind'
    WHEN 'credit_funding' THEN allowed := ARRAY['v','kind','credit_id','fund_id','funded_micro','balance_after_micro','ledger_seq','issued_at','caller_pubkey','dvm_id','dvm','receipt_pubkey','signature'];
    WHEN 'credit_drain' THEN allowed := ARRAY['v','kind','credit_id','drain_id','event','method','amount_micro','balance_after_micro','ledger_seq','issued_at','caller_pubkey','dvm_id','dvm','receipt_pubkey','signature'];
    ELSE
      IF value ? 'kind' THEN RAISE EXCEPTION 'financial export v1: unsupported receipt kind'; END IF;
      allowed := ARRAY['v','job_id','dvm_id','dvm','capability','outcome','reason','ended_by','seq','issued_at','requester_pubkey','result_hash','receipt_pubkey','signature','paid','timing','credit'];
  END CASE;
  FOR item IN SELECT key,val FROM jsonb_each(value) AS e(key,val) LOOP
    IF NOT item.key = ANY(allowed) THEN
      RAISE EXCEPTION 'financial export v1: unsupported signed receipt extension';
    END IF;
    IF item.key = ANY(ARRAY['paid','timing','credit']) THEN
      IF jsonb_typeof(item.val) <> 'object' THEN
        RAISE EXCEPTION 'financial export v1: unsupported receipt block';
      END IF;
      nested_allowed := CASE item.key
        WHEN 'paid' THEN ARRAY['msats','rail','native_amount','native_asset','tx_hash','mint']
        WHEN 'timing' THEN ARRAY['accepted_at_ms','terminal_at_ms','caller_wait_ms']
        WHEN 'credit' THEN ARRAY['credit_id','draw_id','amount','balance_after','ledger_seq'] END;
      FOR nested_item IN SELECT key,val FROM jsonb_each(item.val) AS n(key,val) LOOP
        IF NOT nested_item.key = ANY(nested_allowed) OR jsonb_typeof(nested_item.val) = ANY(ARRAY['object','array']) THEN
          RAISE EXCEPTION 'financial export v1: unsupported signed receipt block extension';
        END IF;
      END LOOP;
    ELSIF jsonb_typeof(item.val) = ANY(ARRAY['object','array']) THEN
      RAISE EXCEPTION 'financial export v1: unsupported receipt field shape';
    END IF;
  END LOOP;
  RETURN value;
END
$$;
-- Unsigned evidence uses explicit scalar projections. Objects/arrays in scalar
-- positions are excluded, including inside the supported nested financial blocks.
CREATE OR REPLACE FUNCTION pg_temp.scalars_v1(value jsonb, strings text[], numbers text[], booleans text[] DEFAULT ARRAY[]::text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) <> 'object' THEN NULL ELSE
    (SELECT COALESCE(jsonb_object_agg(key,val), '{}'::jsonb) FROM jsonb_each(value) AS e(key,val)
     WHERE (key=ANY(strings) AND jsonb_typeof(val) IN ('string','null'))
        OR (key=ANY(numbers) AND (jsonb_typeof(val) IN ('number','null') OR (jsonb_typeof(val)='string' AND val #>> '{}' ~ '^-?[0-9]+$')))
        OR (key=ANY(booleans) AND jsonb_typeof(val) IN ('boolean','null'))) END
$$;
CREATE OR REPLACE FUNCTION pg_temp.draw_refund_result_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.scalars_v1(value, ARRAY['refundId','creditId','drawId','jobId','currency'],
    ARRAY['amountMicro','ledgerSeq','refundedAt','balanceAfterMicro'])
$$;
CREATE OR REPLACE FUNCTION pg_temp.settlement_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.scalars_v1(value,
    ARRAY['tx_hash','transaction','channel_id','network','repair_kind','payer'],
    ARRAY['settledAmount','settled_amount','amount','refunded_native','debited_native','surplus_native'], ARRAY['success','repaired'])
$$;
CREATE OR REPLACE FUNCTION pg_temp.fulfilment_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.scalars_v1(value, ARRAY['source','mintUrl','quoteId'], ARRAY['faceSats','reserveSats','invoiceMsats','routingFeeMsats'])
$$;
CREATE OR REPLACE FUNCTION pg_temp.lot_debits_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) <> 'array' THEN NULL ELSE
    (SELECT COALESCE(jsonb_agg(pg_temp.scalars_v1(item, ARRAY['lotId'], ARRAY['micro','sats'])), '[]'::jsonb)
     FROM jsonb_array_elements(value) item WHERE jsonb_typeof(item)='object') END
$$;
CREATE OR REPLACE FUNCTION pg_temp.effect_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.scalars_v1(value, ARRAY['callerId','dvmId','jobId'],
    ARRAY['requiredMsats','paidMsats','fundedMicro','nativeAmount','topUpCapMicro'], ARRAY['drawBasis','askSatisfied','midJob'])
    || jsonb_strip_nulls(jsonb_build_object(
      'priceFiat', pg_temp.scalars_v1(value->'priceFiat', ARRAY['currency'], ARRAY['amountMicro']),
      'fundOnly', pg_temp.scalars_v1(value->'fundOnly', ARRAY['creditId','fundId'], ARRAY[]::text[]),
      'topUp', pg_temp.scalars_v1(value->'topUp', ARRAY['creditId','drawId'], ARRAY[]::text[]),
      'creditEnvelope', pg_temp.scalars_v1(value->'creditEnvelope', ARRAY['creditId','drawId'], ARRAY[]::text[])))
$$;
CREATE OR REPLACE FUNCTION pg_temp.channel_config_v1(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.scalars_v1(value, ARRAY['payer','payerAuthorizer','receiver','receiverAuthorizer'], ARRAY['withdrawDelay'])
    || CASE WHEN value->>'token' ~ '^0x[0-9a-fA-F]{40}$' THEN jsonb_build_object('token',value->'token') ELSE '{}'::jsonb END
$$;
CREATE OR REPLACE FUNCTION pg_temp.tempo_state_v1(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE state jsonb; amounts jsonb;
BEGIN
  IF value IS NULL OR value='null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(value)<>'string' THEN RETURN NULL; END IF;
  BEGIN state := (value #>> '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'financial export v1: unsupported Tempo state'; END;
  IF jsonb_typeof(state)<>'object' THEN RETURN NULL; END IF;
  -- Normalize the store's tagged bigints without retaining vouchers or signatures.
  SELECT COALESCE(jsonb_object_agg(key, regexp_replace(val #>> '{}', '#__bigint$', '')), '{}'::jsonb) INTO amounts
    FROM jsonb_each(state) AS e(key,val)
    WHERE key=ANY(ARRAY['deposit','spent','settledOnChain','highestVoucherAmount','closeRequestedAt'])
      AND jsonb_typeof(val) IN ('number','string') AND val #>> '{}' ~ '^[0-9]+(#__bigint)?$';
  RETURN pg_temp.scalars_v1(state, ARRAY['channelId','escrowContract','payee','payer'], ARRAY['chainId','units'], ARRAY['finalized']) || amounts
    || CASE WHEN state->>'token' ~ '^0x[0-9a-fA-F]{40}$' THEN jsonb_build_object('token',state->'token') ELSE '{}'::jsonb END;
END
$$;
CREATE OR REPLACE FUNCTION pg_temp.financial_rows_v1(table_name text, columns text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  IF to_regclass(table_name) IS NULL THEN RETURN '[]'::jsonb; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(projected ORDER BY projected::text), ''[]''::jsonb) FROM (
    SELECT (SELECT COALESCE(jsonb_object_agg(key,
      CASE WHEN key=ANY(ARRAY[''sent_ref'',''settle_response'']) THEN pg_temp.settlement_v1(value)
           WHEN key=''result'' THEN pg_temp.draw_refund_result_v1(value)
           WHEN key=''fulfilment'' THEN pg_temp.fulfilment_v1(value)
           WHEN key=''lot_debits'' THEN pg_temp.lot_debits_v1(value)
           WHEN key=''state_json'' THEN pg_temp.tempo_state_v1(value)
           WHEN key=''channel_config'' THEN pg_temp.channel_config_v1(value)
           WHEN key=''effect'' THEN pg_temp.effect_v1(value)
           WHEN key=''receipt'' THEN pg_temp.receipt_v1(value)
           WHEN key=''receipts'' THEN (SELECT COALESCE(jsonb_agg(pg_temp.receipt_v1(r)), ''[]''::jsonb) FROM jsonb_array_elements(value) r)
           ELSE CASE WHEN jsonb_typeof(value) NOT IN (''object'',''array'') THEN value ELSE NULL END END), ''{}''::jsonb)
      FROM jsonb_each(to_jsonb(t)) WHERE key=ANY($1)) projected FROM %I t) rows', table_name)
    INTO result USING columns;
  RETURN result;
END
$$;
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'format', 'dvmkit-financial-evidence', 'version', 1,
  'jobs', pg_temp.financial_rows_v1('jobs', ARRAY['id','dvm_id','request_id','requester_pubkey','capability','status','created_at','last_activity_at','terminal_at_ms','ended_by','receipt','receipt_seq','paid_msats','payment_rail','payment_tx_hash','payment_transaction_hash','native_amount','native_asset','credit_id','draw_id','cost_amount_micro','cost_currency']),
  'credits', pg_temp.financial_rows_v1('credits', ARRAY['credit_id','caller_pubkey','currency','balance_micro','expiry_ms','status','last_ledger_seq','last_funding_ledger_seq','created_at','rail','native_asset','funding_ref','tempo_channel_id','x402_channel_id','msats_remaining','native_remaining']),
  'fundings', pg_temp.financial_rows_v1('credit_fundings', ARRAY['credit_id','fund_id','caller_pubkey','amount_micro','rail','created_at','balance_after_micro','ledger_seq','receipt']),
  'funding_lots', pg_temp.financial_rows_v1('credit_funding_lots', ARRAY['lot_id','credit_id','rail','sats_funded','sats_basis_known','credited_micro','remaining_micro','funding_ref','created_at']),
  'draws', pg_temp.financial_rows_v1('credit_draws', ARRAY['credit_id','draw_id','job_id','amount_micro','ledger_seq','status','balance_after_micro','created_at','resolved_at','draw_msats','allocated_msats','settled_sats','refund_dvm_id','draw_native','grown_micro']),
  'draw_refunds', pg_temp.financial_rows_v1('credit_draw_refunds', ARRAY['refund_id','credit_id','draw_id','amount_micro','restored_sats','result']),
  'drains', pg_temp.financial_rows_v1('credit_drains', ARRAY['credit_id','drain_id','method','amount_micro','balance_after_micro','drained_msats','drained_native','owed_sats','ledger_seq','status','receipts','sent_ref','fulfilment','lot_debits','created_at','parked_at','picked_up_at','sent_at','released_at','written_off_at']),
  'invoices', pg_temp.financial_rows_v1('credit_invoices', ARRAY['credit_id','fund_id','caller_pubkey','currency','amount_micro','amount_msats','payment_hash','status','expires_at','created_at','settled_at','reconciled_credit_id','reconciled_fund_id','resolved_at']),
  'expiry_releases', pg_temp.financial_rows_v1('credit_expiry_releases', ARRAY['credit_id','release_id','caller_pubkey','currency','rail','amount_micro','expiry_ms','released_at','reversed_at']),
  'tempo_channels', pg_temp.financial_rows_v1('mpp_tempo_channels', ARRAY['channel_key','state_json','updated_at']),
  'tempo_channel_tombstones', pg_temp.financial_rows_v1('mpp_tempo_channel_tombstones', ARRAY['channel_key','state_json','deleted_at_ms']),
  'tempo_close_intents', pg_temp.financial_rows_v1('mpp_tempo_close_intents', ARRAY['channel_id','drain_id','reference','forecast_pending','updated_at']),
  'x402_channels', pg_temp.financial_rows_v1('x402_batch_channels', ARRAY['channel_id','channel_config','charged_cumulative_amount','signed_max_claimable','balance','total_claimed','withdraw_requested_at','refund_nonce','onchain_synced_at','last_request_timestamp']),
  'x402_channel_tombstones', pg_temp.financial_rows_v1('x402_batch_channel_tombstones', ARRAY['channel_id','charged_cumulative_amount','signed_max_claimable','refund_nonce','deleted_at_ms']),
  'x402_batch_settlements', pg_temp.financial_rows_v1('x402_batch_settlements', ARRAY['settlement_id','channel_id','operation','effect_id','payment_id','status','submission_block','settle_response','created_at','updated_at','resolved_at']),
  'x402_exact_settlements', pg_temp.financial_rows_v1('x402_exact_settlement_intents', ARRAY['dvm_id','intent_id','network','asset','authorizer','recipient','value','status','effect','submission_block','transaction','settle_response','last_outcome','created_at','updated_at','resolved_at']),
  'tempo_losses', pg_temp.financial_rows_v1('tempo_credit_losses', ARRAY['credit_id','channel_id','caller_pubkey','currency','former_balance_micro','settled_on_chain_native','highest_voucher_native','consumed_service_micro','consumed_native','observed_at']),
  'x402_losses', pg_temp.financial_rows_v1('x402_credit_losses', ARRAY['credit_id','channel_id','caller_pubkey','currency','former_balance_micro','channel_balance_native','total_claimed_native','consumed_service_micro','observed_at'])
);
ROLLBACK;
