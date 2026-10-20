-- Append-only messages and explicit human-authored work. No inspection/billing mutation grants.
CREATE TABLE pitlane.collaboration_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,
 title text NOT NULL CHECK(octet_length(title) BETWEEN 1 AND 200),created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id),UNIQUE(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_sprints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,
 title text NOT NULL CHECK(octet_length(title) BETWEEN 1 AND 200),goal text NOT NULL DEFAULT '' CHECK(octet_length(goal)<=2000),
 starts_at timestamptz,ends_at timestamptz,state text NOT NULL DEFAULT 'planned' CHECK(state IN('planned','active','completed','cancelled')),
 created_by uuid NOT NULL,updated_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(starts_at IS NULL OR ends_at IS NULL OR starts_at<ends_at),FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id),UNIQUE(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_work_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,
 title text NOT NULL CHECK(octet_length(title) BETWEEN 1 AND 200),description text NOT NULL DEFAULT '' CHECK(octet_length(description)<=4000),
 state text NOT NULL DEFAULT 'todo' CHECK(state IN('todo','in_progress','blocked','done')),assignee_id uuid,sprint_id uuid,
 created_by uuid NOT NULL,updated_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id),FOREIGN KEY(tenant_id,assignee_id) REFERENCES pitlane.tenant_memberships(tenant_id,user_id),
 FOREIGN KEY(sprint_id,tenant_id,project_id) REFERENCES pitlane.collaboration_sprints(id,tenant_id,project_id),UNIQUE(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,conversation_id uuid NOT NULL,
 author_id uuid,role text NOT NULL CHECK(role IN('user','assistant')),origin text NOT NULL CHECK(origin IN('user','openai','fixture')),
 content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 8000),reply_to_message_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((role='user' AND author_id IS NOT NULL AND origin='user' AND reply_to_message_id IS NULL AND octet_length(content)<=4000) OR (role='assistant' AND author_id IS NULL AND origin IN('openai','fixture') AND reply_to_message_id IS NOT NULL)),
 FOREIGN KEY(conversation_id,tenant_id,project_id) REFERENCES pitlane.collaboration_conversations(id,tenant_id,project_id),UNIQUE(id,tenant_id,project_id),UNIQUE(reply_to_message_id),
 FOREIGN KEY(reply_to_message_id,tenant_id,project_id) REFERENCES pitlane.collaboration_messages(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_message_receipts (
 message_id uuid NOT NULL,tenant_id uuid NOT NULL,project_id uuid NOT NULL,version_id uuid NOT NULL,PRIMARY KEY(message_id,version_id),
 FOREIGN KEY(message_id,tenant_id,project_id) REFERENCES pitlane.collaboration_messages(id,tenant_id,project_id),FOREIGN KEY(version_id,tenant_id,project_id) REFERENCES pitlane.receipt_versions(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_message_work (
 message_id uuid NOT NULL,tenant_id uuid NOT NULL,project_id uuid NOT NULL,work_item_id uuid NOT NULL,PRIMARY KEY(message_id,work_item_id),
 FOREIGN KEY(message_id,tenant_id,project_id) REFERENCES pitlane.collaboration_messages(id,tenant_id,project_id),FOREIGN KEY(work_item_id,tenant_id,project_id) REFERENCES pitlane.collaboration_work_items(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_work_receipts (
 work_item_id uuid NOT NULL,tenant_id uuid NOT NULL,project_id uuid NOT NULL,version_id uuid NOT NULL,PRIMARY KEY(work_item_id,version_id),
 FOREIGN KEY(work_item_id,tenant_id,project_id) REFERENCES pitlane.collaboration_work_items(id,tenant_id,project_id),FOREIGN KEY(version_id,tenant_id,project_id) REFERENCES pitlane.receipt_versions(id,tenant_id,project_id)
);
CREATE TABLE pitlane.collaboration_mutations (
 tenant_id uuid NOT NULL,project_id uuid NOT NULL,actor_id uuid NOT NULL,kind text NOT NULL,key text NOT NULL CHECK(octet_length(key) BETWEEN 8 AND 128),
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,project_id,actor_id,kind,key),
 FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id)
);
CREATE TABLE pitlane.collaboration_ai_days (
 tenant_id uuid NOT NULL,project_id uuid NOT NULL,day date NOT NULL,max_requests integer NOT NULL CHECK(max_requests BETWEEN 1 AND 500),max_tokens integer NOT NULL CHECK(max_tokens BETWEEN 1 AND 5000000),max_cost_micro bigint NOT NULL CHECK(max_cost_micro BETWEEN 1 AND 1000000000),
 attempts integer NOT NULL DEFAULT 0,charged_tokens bigint NOT NULL DEFAULT 0,charged_cost_micro bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,project_id,day),FOREIGN KEY(project_id,tenant_id) REFERENCES pitlane.projects(id,tenant_id)
);
CREATE TABLE pitlane.collaboration_ai_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,project_id uuid NOT NULL,conversation_id uuid NOT NULL,message_id uuid NOT NULL,actor_id uuid NOT NULL,
 key text NOT NULL CHECK(octet_length(key) BETWEEN 8 AND 128),fingerprint text NOT NULL,status text NOT NULL CHECK(status IN('unavailable','capped','running','completed','failed','uncertain')),
 provider text,model text,origin text CHECK(origin IN('openai','fixture')),reason text,provider_response_id text CHECK(octet_length(provider_response_id)<=200),http_status integer CHECK(http_status BETWEEN 100 AND 599),provider_status text CHECK(provider_status IN('completed','incomplete','failed','cancelled','queued','in_progress','unknown')),
 input_tokens integer,output_tokens integer,total_tokens integer,cost_micro bigint,reserved_tokens integer NOT NULL DEFAULT 0,reserved_cost_micro bigint NOT NULL DEFAULT 0,
 input_price bigint NOT NULL DEFAULT 0,output_price bigint NOT NULL DEFAULT 0,day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
 context_digest text,dispatch_token uuid,deadline timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(tenant_id,project_id,conversation_id,actor_id,key),UNIQUE(message_id),FOREIGN KEY(message_id,tenant_id,project_id) REFERENCES pitlane.collaboration_messages(id,tenant_id,project_id),
 FOREIGN KEY(conversation_id,tenant_id,project_id) REFERENCES pitlane.collaboration_conversations(id,tenant_id,project_id)
);
CREATE INDEX collaboration_conversations_page ON pitlane.collaboration_conversations(tenant_id,project_id,created_at DESC,id DESC);
CREATE INDEX collaboration_messages_page ON pitlane.collaboration_messages(tenant_id,project_id,conversation_id,created_at DESC,id DESC);
CREATE INDEX collaboration_work_page ON pitlane.collaboration_work_items(tenant_id,project_id,created_at DESC,id DESC);
CREATE INDEX collaboration_sprints_page ON pitlane.collaboration_sprints(tenant_id,project_id,created_at DESC,id DESC);
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['collaboration_conversations','collaboration_sprints','collaboration_work_items','collaboration_messages','collaboration_message_receipts','collaboration_message_work','collaboration_work_receipts','collaboration_mutations','collaboration_ai_days','collaboration_ai_requests'] LOOP
  EXECUTE format('ALTER TABLE pitlane.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY scoped_read ON pitlane.%I FOR SELECT USING(pitlane.can_project(tenant_id,project_id))',n);
 END LOOP;
END $$;
GRANT SELECT ON pitlane.collaboration_conversations,pitlane.collaboration_sprints,pitlane.collaboration_work_items,pitlane.collaboration_messages,pitlane.collaboration_message_receipts,pitlane.collaboration_message_work,pitlane.collaboration_work_receipts,pitlane.collaboration_ai_days TO pitlane_web;
-- Tokens used to finish requests and message fingerprints are deliberately not readable.
GRANT SELECT(id,tenant_id,project_id,conversation_id,message_id,actor_id,status,provider,model,origin,reason,provider_response_id,http_status,provider_status,input_tokens,output_tokens,total_tokens,cost_micro,reserved_tokens,reserved_cost_micro,created_at,finished_at) ON pitlane.collaboration_ai_requests TO pitlane_web;

CREATE FUNCTION pitlane.collaboration_check_links(t uuid,p uuid,receipts jsonb,items jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE link text;
BEGIN
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF jsonb_typeof(receipts)<>'array' OR jsonb_typeof(items)<>'array' OR jsonb_array_length(receipts)>5 OR jsonb_array_length(items)>5 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 FOR link IN SELECT jsonb_array_elements_text(receipts) LOOP
  IF NOT EXISTS(SELECT FROM pitlane.receipt_versions v JOIN pitlane.artifacts a ON a.id=v.artifact_id AND a.tenant_id=t AND a.project_id=p WHERE v.id=link::uuid AND v.tenant_id=t AND v.project_id=p AND v.expires_at>clock_timestamp() AND a.state='published' AND a.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 END LOOP;
 FOR link IN SELECT jsonb_array_elements_text(items) LOOP
  IF NOT EXISTS(SELECT FROM pitlane.collaboration_work_items WHERE id=link::uuid AND tenant_id=t AND project_id=p) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 END LOOP;
END $$;

CREATE FUNCTION pitlane.collaboration_mutate(p uuid,kind text,target uuid,input jsonb,request_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();a uuid=pitlane.actor_id();saved pitlane.collaboration_mutations;fingerprint text;value jsonb;previous jsonb;link text;
BEGIN
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF kind NOT IN('conversation','sprint','work') OR octet_length(request_key) NOT BETWEEN 8 AND 128 OR jsonb_typeof(input)<>'object' THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||p::text||'/collaboration',0));
 -- Recheck after a contended lock; membership may have changed while waiting.
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 fingerprint=encode(sha256(convert_to(jsonb_build_object('target',target,'input',input)::text,'UTF8')),'hex');
 SELECT * INTO saved FROM pitlane.collaboration_mutations m WHERE m.tenant_id=t AND m.project_id=p AND m.actor_id=a AND m.kind=collaboration_mutate.kind AND m.key=request_key;
 IF FOUND THEN IF saved.fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;RETURN saved.result;END IF;
 IF target IS NOT NULL THEN
  IF kind='conversation' THEN SELECT to_jsonb(c) INTO previous FROM pitlane.collaboration_conversations c WHERE id=target AND tenant_id=t AND project_id=p FOR UPDATE;
  ELSIF kind='sprint' THEN SELECT to_jsonb(s) INTO previous FROM pitlane.collaboration_sprints s WHERE id=target AND tenant_id=t AND project_id=p FOR UPDATE;
  ELSE SELECT to_jsonb(w) INTO previous FROM pitlane.collaboration_work_items w WHERE id=target AND tenant_id=t AND project_id=p FOR UPDATE;END IF;
  IF previous IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
  IF (input->>'expectedVersion')::integer IS DISTINCT FROM (previous->>'version')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 ELSE
  IF kind='conversation' AND (SELECT count(*) FROM pitlane.collaboration_conversations WHERE tenant_id=t AND project_id=p)>=200 OR kind='sprint' AND (SELECT count(*) FROM pitlane.collaboration_sprints WHERE tenant_id=t AND project_id=p)>=200 OR kind='work' AND (SELECT count(*) FROM pitlane.collaboration_work_items WHERE tenant_id=t AND project_id=p)>=2000 THEN RAISE EXCEPTION 'WORKSPACE_LIMIT';END IF;
 END IF;
 IF input ? 'title' AND (jsonb_typeof(input->'title')<>'string' OR octet_length(btrim(input->>'title')) NOT BETWEEN 1 AND 200) OR target IS NULL AND NOT input ? 'title' THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF kind='conversation' THEN
  IF target IS NULL THEN INSERT INTO pitlane.collaboration_conversations(tenant_id,project_id,title,created_by) VALUES(t,p,btrim(input->>'title'),a) RETURNING to_jsonb(collaboration_conversations) INTO value;
  ELSE UPDATE pitlane.collaboration_conversations SET title=coalesce(btrim(input->>'title'),title),version=version+1,updated_at=clock_timestamp() WHERE id=target RETURNING to_jsonb(collaboration_conversations) INTO value;END IF;
 ELSIF kind='sprint' THEN
  IF input ? 'goal' AND (jsonb_typeof(input->'goal')<>'string' OR octet_length(input->>'goal')>2000) OR input ? 'state' AND input->>'state' NOT IN('planned','active','completed','cancelled') THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
  IF target IS NULL THEN INSERT INTO pitlane.collaboration_sprints(tenant_id,project_id,title,goal,starts_at,ends_at,state,created_by,updated_by) VALUES(t,p,btrim(input->>'title'),coalesce(input->>'goal',''),(input->>'startsAt')::timestamptz,(input->>'endsAt')::timestamptz,coalesce(input->>'state','planned'),a,a) RETURNING to_jsonb(collaboration_sprints) INTO value;
  ELSE UPDATE pitlane.collaboration_sprints SET title=coalesce(btrim(input->>'title'),title),goal=coalesce(input->>'goal',goal),starts_at=CASE WHEN input ? 'startsAt' THEN (input->>'startsAt')::timestamptz ELSE starts_at END,ends_at=CASE WHEN input ? 'endsAt' THEN (input->>'endsAt')::timestamptz ELSE ends_at END,state=coalesce(input->>'state',state),version=version+1,updated_by=a,updated_at=clock_timestamp() WHERE id=target RETURNING to_jsonb(collaboration_sprints) INTO value;END IF;
 ELSE
  IF input ? 'description' AND (jsonb_typeof(input->'description')<>'string' OR octet_length(input->>'description')>4000) OR input ? 'state' AND input->>'state' NOT IN('todo','in_progress','blocked','done') THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
  IF input->>'assigneeId' IS NOT NULL AND NOT EXISTS(SELECT FROM pitlane.tenant_memberships m WHERE m.tenant_id=t AND m.user_id=(input->>'assigneeId')::uuid AND m.active AND (m.role IN('owner','admin') OR EXISTS(SELECT FROM pitlane.project_memberships pm WHERE pm.tenant_id=t AND pm.project_id=p AND pm.user_id=m.user_id AND pm.active))) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
  IF input->>'sprintId' IS NOT NULL AND NOT EXISTS(SELECT FROM pitlane.collaboration_sprints WHERE id=(input->>'sprintId')::uuid AND tenant_id=t AND project_id=p) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
  IF input ? 'receiptVersionIds' THEN PERFORM pitlane.collaboration_check_links(t,p,input->'receiptVersionIds','[]');END IF;
  IF target IS NULL THEN INSERT INTO pitlane.collaboration_work_items(tenant_id,project_id,title,description,state,assignee_id,sprint_id,created_by,updated_by) VALUES(t,p,btrim(input->>'title'),coalesce(input->>'description',''),coalesce(input->>'state','todo'),(input->>'assigneeId')::uuid,(input->>'sprintId')::uuid,a,a) RETURNING to_jsonb(collaboration_work_items) INTO value;target=(value->>'id')::uuid;
  ELSE UPDATE pitlane.collaboration_work_items SET title=coalesce(btrim(input->>'title'),title),description=coalesce(input->>'description',description),state=coalesce(input->>'state',state),assignee_id=CASE WHEN input ? 'assigneeId' THEN (input->>'assigneeId')::uuid ELSE assignee_id END,sprint_id=CASE WHEN input ? 'sprintId' THEN (input->>'sprintId')::uuid ELSE sprint_id END,version=version+1,updated_by=a,updated_at=clock_timestamp() WHERE id=target RETURNING to_jsonb(collaboration_work_items) INTO value;END IF;
  IF input ? 'receiptVersionIds' THEN
   DELETE FROM pitlane.collaboration_work_receipts WHERE work_item_id=target;
   FOR link IN SELECT DISTINCT jsonb_array_elements_text(input->'receiptVersionIds') LOOP INSERT INTO pitlane.collaboration_work_receipts VALUES(target,t,p,link::uuid);END LOOP;
  END IF;
  value=value||jsonb_build_object('receipt_version_ids',(SELECT coalesce(jsonb_agg(version_id ORDER BY version_id),'[]') FROM pitlane.collaboration_work_receipts WHERE work_item_id=target));
 END IF;
 INSERT INTO pitlane.collaboration_mutations(tenant_id,project_id,actor_id,kind,key,fingerprint,result) VALUES(t,p,a,kind,request_key,fingerprint,value);
 INSERT INTO pitlane.audit(tenant_id,actor_id,type,subject_id) VALUES(t,a,'COLLABORATION_'||upper(kind)||'_CHANGED',(value->>'id')::uuid);
 RETURN value;
END $$;

CREATE FUNCTION pitlane.collaboration_request_public(r pitlane.collaboration_ai_requests) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(r)-ARRAY['key','fingerprint','dispatch_token','context_digest','input_price','output_price','day','deadline','actor_id'] $$;

CREATE FUNCTION pitlane.collaboration_send(p uuid,c uuid,input jsonb,request_key text,configuration jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();a uuid=pitlane.actor_id();fingerprint text;request pitlane.collaboration_ai_requests;message pitlane.collaboration_messages;link text;d date=(clock_timestamp() AT TIME ZONE 'UTC')::date;budget pitlane.collaboration_ai_days;tokens integer;cost bigint;dispatch boolean=false;
BEGIN
 IF NOT pitlane.can_project(t,p,true) OR NOT EXISTS(SELECT FROM pitlane.collaboration_conversations WHERE id=c AND tenant_id=t AND project_id=p) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF jsonb_typeof(input)<>'object' OR jsonb_typeof(input->'content')<>'string' OR octet_length(btrim(input->>'content')) NOT BETWEEN 1 AND 4000 OR octet_length(request_key) NOT BETWEEN 8 AND 128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||p::text||'/collaboration',0));
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 fingerprint=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 SELECT * INTO request FROM pitlane.collaboration_ai_requests WHERE tenant_id=t AND project_id=p AND conversation_id=c AND actor_id=a AND key=request_key FOR UPDATE;
 IF FOUND THEN
  IF request.fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  IF request.status='running' AND request.deadline<clock_timestamp() THEN UPDATE pitlane.collaboration_ai_requests SET status='uncertain',reason='PROVIDER_UNCERTAIN',finished_at=clock_timestamp() WHERE id=request.id RETURNING * INTO request;END IF;
  SELECT * INTO message FROM pitlane.collaboration_messages WHERE id=request.message_id;
 ELSE
  PERFORM pitlane.collaboration_check_links(t,p,coalesce(input->'receiptVersionIds','[]'),coalesce(input->'workItemIds','[]'));
  IF (SELECT count(*) FROM pitlane.collaboration_messages WHERE conversation_id=c)>=1000 THEN RAISE EXCEPTION 'MESSAGE_LIMIT';END IF;
  INSERT INTO pitlane.collaboration_messages(tenant_id,project_id,conversation_id,author_id,role,origin,content) VALUES(t,p,c,a,'user','user',input->>'content') RETURNING * INTO message;
  FOR link IN SELECT DISTINCT jsonb_array_elements_text(coalesce(input->'receiptVersionIds','[]')) LOOP INSERT INTO pitlane.collaboration_message_receipts VALUES(message.id,t,p,link::uuid);END LOOP;
  FOR link IN SELECT DISTINCT jsonb_array_elements_text(coalesce(input->'workItemIds','[]')) LOOP INSERT INTO pitlane.collaboration_message_work VALUES(message.id,t,p,link::uuid);END LOOP;
  INSERT INTO pitlane.collaboration_ai_requests(tenant_id,project_id,conversation_id,message_id,actor_id,key,fingerprint,status,reason) VALUES(t,p,c,message.id,a,request_key,fingerprint,'unavailable','AI_UNAVAILABLE') RETURNING * INTO request;
  IF configuration->>'provider' IN('openai','fixture') AND configuration->>'origin'=configuration->>'provider' AND octet_length(configuration->>'model') BETWEEN 1 AND 128 AND (configuration->>'provider'<>'fixture' OR (SELECT mode FROM pitlane.runtime)='local') THEN
   IF (configuration->>'maxOutputTokens')::integer NOT BETWEEN 16 AND 2048 OR (configuration->>'inputPrice')::bigint NOT BETWEEN 1 AND 1000000000 OR (configuration->>'outputPrice')::bigint NOT BETWEEN 1 AND 1000000000 THEN RAISE EXCEPTION 'INVALID_AI_CONFIGURATION';END IF;
   tokens=16000+(configuration->>'maxOutputTokens')::integer;
   cost=ceil((16000::numeric*(configuration->>'inputPrice')::bigint+(configuration->>'maxOutputTokens')::numeric*(configuration->>'outputPrice')::bigint)/1000000)::bigint;
   INSERT INTO pitlane.collaboration_ai_days(tenant_id,project_id,day,max_requests,max_tokens,max_cost_micro) VALUES(t,p,d,(configuration->>'dailyRequests')::integer,(configuration->>'dailyTokens')::integer,(configuration->>'dailyCostMicro')::bigint)
   ON CONFLICT(tenant_id,project_id,day) DO UPDATE SET max_requests=least(collaboration_ai_days.max_requests,excluded.max_requests),max_tokens=least(collaboration_ai_days.max_tokens,excluded.max_tokens),max_cost_micro=least(collaboration_ai_days.max_cost_micro,excluded.max_cost_micro) RETURNING * INTO budget;
   IF budget.attempts+1>budget.max_requests OR budget.charged_tokens+tokens>budget.max_tokens OR budget.charged_cost_micro+cost>budget.max_cost_micro THEN
    UPDATE pitlane.collaboration_ai_requests SET status='capped',provider=configuration->>'provider',model=configuration->>'model',origin=configuration->>'origin',reason='DAILY_AI_ALLOWANCE',finished_at=clock_timestamp() WHERE id=request.id RETURNING * INTO request;
   ELSE
    UPDATE pitlane.collaboration_ai_days SET attempts=attempts+1,charged_tokens=charged_tokens+tokens,charged_cost_micro=charged_cost_micro+cost WHERE tenant_id=t AND project_id=p AND day=d;
    UPDATE pitlane.collaboration_ai_requests SET status='running',provider=configuration->>'provider',model=configuration->>'model',origin=configuration->>'origin',reason=NULL,reserved_tokens=tokens,reserved_cost_micro=cost,input_price=(configuration->>'inputPrice')::bigint,output_price=(configuration->>'outputPrice')::bigint,dispatch_token=gen_random_uuid(),deadline=clock_timestamp()+interval '25 seconds' WHERE id=request.id RETURNING * INTO request;dispatch=true;
   END IF;
  END IF;
  UPDATE pitlane.collaboration_conversations SET updated_at=clock_timestamp() WHERE id=c;
 END IF;
 RETURN jsonb_build_object('messageId',message.id,'request',pitlane.collaboration_request_public(request),'dispatch',dispatch,'dispatchToken',CASE WHEN dispatch THEN request.dispatch_token ELSE NULL END);
END $$;

CREATE FUNCTION pitlane.collaboration_ai_context(p uuid,request_id uuid,token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();r pitlane.collaboration_ai_requests;
BEGIN
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO r FROM pitlane.collaboration_ai_requests WHERE id=request_id AND tenant_id=t AND project_id=p AND actor_id=pitlane.actor_id() AND dispatch_token=token AND status='running' AND deadline>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 RETURN jsonb_build_object(
 'messages',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',m.role,'content',m.content) ORDER BY m.created_at,m.id),'[]') FROM (SELECT role,content,created_at,id FROM pitlane.collaboration_messages WHERE conversation_id=r.conversation_id AND created_at<=(SELECT created_at FROM pitlane.collaboration_messages WHERE id=r.message_id) ORDER BY created_at DESC,id DESC LIMIT 8) m),
 'receipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('versionId',v.id,'finding',v.payload->>'finding','issuedAt',v.issued_at,'origin',v.payload->>'origin','ruleVersion',v.payload->>'ruleVersion','assertions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','path',x->>'path','state',x->>'state')),'[]') FROM (SELECT x FROM jsonb_array_elements(coalesce(v.payload->'assertions','[]')) x LIMIT 10) limited))),'[]') FROM pitlane.collaboration_message_receipts l JOIN pitlane.receipt_versions v ON v.id=l.version_id JOIN pitlane.artifacts f ON f.id=v.artifact_id WHERE l.message_id=r.message_id AND v.tenant_id=t AND v.project_id=p AND v.expires_at>clock_timestamp() AND f.state='published' AND f.expires_at>clock_timestamp()),
 'workItems',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'title',w.title,'state',w.state,'version',w.version)),'[]') FROM pitlane.collaboration_message_work l JOIN pitlane.collaboration_work_items w ON w.id=l.work_item_id WHERE l.message_id=r.message_id AND w.tenant_id=t AND w.project_id=p));
END $$;

CREATE FUNCTION pitlane.collaboration_ai_finish(p uuid,request_id uuid,token uuid,result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();r pitlane.collaboration_ai_requests;cost bigint;used integer;new_status text;finish_reason text;
BEGIN
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO r FROM pitlane.collaboration_ai_requests WHERE id=request_id AND tenant_id=t AND project_id=p AND actor_id=pitlane.actor_id() AND dispatch_token=token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF NOT pitlane.can_project(t,p,true) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF r.status<>'running' THEN RETURN pitlane.collaboration_request_public(r);END IF;
 new_status=result->>'status';finish_reason=result->>'reason';
 IF new_status NOT IN('completed','failed','uncertain') OR finish_reason IS NOT NULL AND finish_reason NOT IN('PROVIDER_REJECTED','PROVIDER_UNCERTAIN','INVALID_PROVIDER_RESPONSE','RESPONSE_LIMIT','CONTEXT_LIMIT','SECRET_REDACTED') THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF result->>'contextDigest' IS NOT NULL AND result->>'contextDigest' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF result->>'responseId' IS NOT NULL AND octet_length(result->>'responseId')>200 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF result ? 'usage' AND result->'usage'<>'null'::jsonb THEN
  used=(result->'usage'->>'totalTokens')::integer;
  IF (result->'usage'->>'inputTokens')::integer<0 OR (result->'usage'->>'outputTokens')::integer<0 OR used<>(result->'usage'->>'inputTokens')::integer+(result->'usage'->>'outputTokens')::integer OR used>100000000 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
  cost=ceil(((result->'usage'->>'inputTokens')::numeric*r.input_price+(result->'usage'->>'outputTokens')::numeric*r.output_price)/1000000)::bigint;
  -- Retain measured overage truthfully and prevent further dispatches; never emit an unbounded reply.
  IF used>r.reserved_tokens OR cost>r.reserved_cost_micro THEN new_status='uncertain';finish_reason='RESPONSE_LIMIT';END IF;
  UPDATE pitlane.collaboration_ai_days SET charged_tokens=charged_tokens-r.reserved_tokens+used,charged_cost_micro=charged_cost_micro-r.reserved_cost_micro+cost WHERE tenant_id=t AND project_id=p AND day=r.day;
 END IF;
 IF new_status='completed' THEN
  IF used IS NULL OR jsonb_typeof(result->'content')<>'string' OR octet_length(btrim(result->>'content')) NOT BETWEEN 1 AND 8000 OR r.deadline<clock_timestamp() THEN new_status='uncertain';finish_reason='INVALID_PROVIDER_RESPONSE';
  ELSE INSERT INTO pitlane.collaboration_messages(tenant_id,project_id,conversation_id,role,origin,content,reply_to_message_id) VALUES(t,p,r.conversation_id,'assistant',r.origin,result->>'content',r.message_id);END IF;
 END IF;
 UPDATE pitlane.collaboration_ai_requests SET status=new_status,reason=finish_reason,provider_response_id=result->>'responseId',http_status=(result->>'httpStatus')::integer,provider_status=result->>'providerStatus',input_tokens=(result->'usage'->>'inputTokens')::integer,output_tokens=(result->'usage'->>'outputTokens')::integer,total_tokens=used,cost_micro=cost,context_digest=result->>'contextDigest',finished_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
 RETURN pitlane.collaboration_request_public(r);
END $$;
CREATE FUNCTION pitlane.collaboration_ai_expire(p uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF NOT pitlane.can_project(pitlane.actor_tenant(),p) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 UPDATE pitlane.collaboration_ai_requests SET status='uncertain',reason='PROVIDER_UNCERTAIN',finished_at=clock_timestamp() WHERE tenant_id=pitlane.actor_tenant() AND project_id=p AND status='running' AND deadline<clock_timestamp();
END $$;
REVOKE ALL ON FUNCTION pitlane.collaboration_check_links(uuid,uuid,jsonb,jsonb),pitlane.collaboration_mutate(uuid,text,uuid,jsonb,text),pitlane.collaboration_request_public(pitlane.collaboration_ai_requests),pitlane.collaboration_send(uuid,uuid,jsonb,text,jsonb),pitlane.collaboration_ai_context(uuid,uuid,uuid),pitlane.collaboration_ai_finish(uuid,uuid,uuid,jsonb),pitlane.collaboration_ai_expire(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.collaboration_mutate(uuid,text,uuid,jsonb,text),pitlane.collaboration_send(uuid,uuid,jsonb,text,jsonb),pitlane.collaboration_ai_context(uuid,uuid,uuid),pitlane.collaboration_ai_finish(uuid,uuid,uuid,jsonb),pitlane.collaboration_ai_expire(uuid) TO pitlane_web;
