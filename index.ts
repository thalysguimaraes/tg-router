import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decideRoute, childFloorFor, QUOTA_MAX_AGE_MS } from './policy';
import { contextTools } from './context-tools';
import { inspectQuotas } from './quota';
import { getPromotion } from './promotion';
import { inspectMeridian, withMeridianProfile } from './meridian';
import { BudgetLedger, estimateUpperBoundUsd } from './budget';
import { streamSimple, registerCustomApi, unregisterCustomApis } from '@oh-my-pi/pi-ai';
import { installGuardedOpenRouter, guardOpenRouterModel, GUARDED_OPENROUTER_MARKER } from './guarded-openrouter';
import { randomUUID } from 'node:crypto';
import { buildSessionContext, AgentRegistry, MAIN_AGENT_ID } from '@oh-my-pi/pi-coding-agent';
import { writeFanout, readSiblings, removeFanout } from './fanout';
import { installNineRouter, type NineRouterController } from './ninerouter';
import { gatewayQuota, readNineRouterUsage, refreshNineRouterUsage, nineRouterSession, readPasswordFromOp, NINE_ROUTER_REFRESH_THROTTLE_MS } from './ninerouter-usage';
import { steerAccounts } from './accounts';
import { installProviderDiagnostics } from './diagnostics';
import { buildRoutingContext, assessmentCacheKey, JEV_SCHEMA_VERSION, JEV_QUESTION_SET_VERSION } from './routing-context';
import { AssessmentCache, cacheKeyFor } from './assessment-cache';
import { createJevClient, JEVS_CLASSIFIER_MODEL, JEV_INPUT_USD_PER_MTOK } from './jev-client';
import { resolveClassification, type RouteTier, type SemanticAssessment, type SemanticMode } from './policy';

const VERSION='1.2.0';
const REFS=['openai-codex/gpt-6-astra','openai-codex/gpt-5.6-sol','openai-codex/gpt-5.6-luna','anthropic/claude-fable-5-1','anthropic/claude-sonnet-5','anthropic/claude-opus-5','opencode-go/deepseek-v4.1-flash','opencode-go/glm-5.3-flash'];
const BACKUPS=['openrouter/openai/gpt-5.6-sol','openrouter/anthropic/claude-opus-5','openrouter/openai/gpt-6-astra'];
const STEER_INTERVAL_MS=600_000;
const steerThrottle:Record<string,number>={};
const ref=(model:any)=>model ? `${model.provider}/${model.id}` : undefined;
const parse=(file:string,fallback:any)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return fallback;}};
const textLength=(value:any):number=>{
  if(typeof value==='string')return value.length;
  if(!value||typeof value!=='object')return 0;
  if(value.type==='image')return 8000;
  return Array.isArray(value)?value.reduce((sum,v)=>sum+textLength(v),0):Object.entries(value).reduce((sum,[k,v])=>sum+(k==='data'||k==='signature'?0:textLength(v)),0);
};
const hasImage=(v:any):boolean=>!!v&&typeof v==='object'&&(v.type==='image'||(Array.isArray(v)?v.some(hasImage):Object.values(v).some(hasImage)));

export default function personalRouter(pi:any) {
  const root=process.env.OMP_PERSONAL_ROUTER_HOME ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(),'.omp','agent'),'personal-router');
  mkdirSync(root,{recursive:true,mode:0o700});
  const settingsFile=join(root,'settings.json');
  let ctxCurrent:any, state:any={}, child=false, lastActual:string|undefined, lastStatus:any, lastQuota:any, blocked=false;
  let ledger:BudgetLedger|undefined, reservation:any;
  let nineRouter:NineRouterController;
  let gatewayUsage:any;
  let usageRefreshAt=0;
  let usageRefreshPromise:Promise<unknown>|undefined;
  let semanticMode:SemanticMode='off';
  let lastSemanticTrace:any;
  const settings=()=>parse(settingsFile,{enabled:true,goValidated:[],goVisionValidated:[],paidFallbackEnabled:false});
  const TYPESAFE_PROVIDER='typesafe';
  /**
   * The user sees two states: auto and pin. Inside auto, Jev assists whenever a
   * key is present; otherwise rules run alone and the status line says so.
   * `assisted` is the only mode the user ever gets: it can clarify phase and
   * raise the floor, never lower it. `shadow` and `calibrated` are rollout /
   * research modes reachable only via `semanticRouter.mode` in settings.json;
   * they are not commands and are not shown as options.
   */
  const semanticSettings=()=> {
    const override=settings().semanticRouter?.mode;
    const developerMode=(['off','shadow','calibrated'] as const).includes(override)?override as SemanticMode:undefined;
    return { mode:developerMode??('assisted' as SemanticMode), overridden:developerMode!==undefined };
  };
  // The TypeSafe key lives in omp's own credential store, the same place every
  // other provider key lives, so it survives shells and restarts. authStorage
  // resolves stored key first, then TYPESAFE_API_KEY from the environment.
  // Never read from or written to settings.json.
  const typesafeKey=async():Promise<string|undefined>=>{
    try{return await ctxCurrent?.modelRegistry?.authStorage?.getApiKey(TYPESAFE_PROVIDER)??process.env.TYPESAFE_API_KEY;}
    catch{return process.env.TYPESAFE_API_KEY;}
  };
  /** 1Password item holding the TypeSafe key (a LOGIN item: the key is in `password`). */
  const TYPESAFE_OP_REF='op://Personal/AgentKit - Typesafe/password';
  // `/route key` is the rotation path, so it always reads the vault itself and
  // refreshes the keychain cache; it never serves a stale cached key.
  const readTypesafeKeyFromOp=()=>readPasswordFromOp(TYPESAFE_OP_REF,AbortSignal.timeout(60_000),{forceVaultRead:true});
  const budget=()=>ledger??=new BudgetLedger(join(root,'budget.sqlite'),{dailyCapUsd:settings().dailyCashCapUsd??10,monthlyCapUsd:settings().monthlyCashCapUsd??30});
  const assessmentCache=new AssessmentCache();
  const jev=createJevClient({
    // Measured against api.typesafe.ai: warm calls settle at ~290-360ms, but the
    // first call of a fresh process pays TLS + connection setup and lands at
    // ~790-840ms. At 750ms every session's first routing decision aborted and
    // fell back to rules. This is a ceiling, not a delay: warm calls still
    // return in ~300ms, so raising it only stops discarding the cold answer.
    deadlineMs:1500,
    admit:(estimateUsd)=>{
      const result=budget().reserve(`classifier-${randomUUID()}`,estimateUsd,Date.now(),{purpose:'classifier',subcaps:{dailyCapUsd:0.10,monthlyCapUsd:1.00}});
      if(!result.ok)return {ok:false as const,reason:result.reason};
      return {ok:true as const};
    },
    inputUsdPerMillion:JEV_INPUT_USD_PER_MTOK,
    // Resolved per call, never snapshotted: the key can be stored after load.
    apiKey:typesafeKey,
  });
  const priceCeiling=(m:any)=>{
    const configured=settings().openrouterPriceCeilings?.[m.id];
    if(configured)return configured;
    const input=Math.max(m.cost?.input??NaN,m.cost?.cacheRead??0,m.cost?.cacheWrite??0)*4;
    return {input,output:(m.cost?.output??NaN)*4,cacheRead:input,cacheWrite:input};
  };
  const guard=installGuardedOpenRouter({ledger:budget,nativeStreamSimple:streamSimple,registerCustomApi,unregisterCustomApis,ratesFor:priceCeiling,maxOutputTokens:32768,onEvent:log,onBlocked:(reason)=>{blocked=true;ctxCurrent?.abort();notify(`OpenRouter: chamada bloqueada (${reason}).`,'warning');}});
  function releaseUndispatched(){if(reservation&&!reservation.dispatched){budget().releaseBeforeDispatch(reservation.id);reservation=undefined;}}
  async function reconcile(ctx:any) {
    const pending=budget().pendingGenerations();if(!pending.length)return;
    const apiKey=await ctx.modelRegistry.authStorage.getApiKey('openrouter');if(!apiKey)return;
    await Promise.all(pending.map(async p=>{
      try{
        const r=await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(p.generationId)}`,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(4000)});
        if(!r.ok)return;const body:any=await r.json();const cost=body.data?.total_cost;
        if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0)return;
        const settled=budget().settle(p.requestId,cost);log('budget-settled',{requestId:p.requestId,actualUsd:cost,overEstimateUsd:settled.overEstimateUsd});
      }catch{}
    }));
  }
  function log(event:string,data:any={}) {
    appendFileSync(join(root,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),version:VERSION,event,sessionId:ctxCurrent?.sessionManager.getSessionId(),child,...data})+'\n',{mode:0o600});
  }
  function save() { pi.appendEntry('personal-router-state',state); }
  function notify(text:string,level='info') { ctxCurrent?.ui.notify(text,level); }
  const isGateway=(model:any):boolean=>model?.provider==='9router'||model?.gateway===true||model?.ref?.startsWith('9router/');
  const canonical=(model:any):string|undefined=>{
    if(!model)return undefined;
    if(typeof model==='string')return model.startsWith('9router/')?(nineRouter?.canonicalRef(model)??model):model;
    if(typeof model.canonicalRef==='string'&&model.canonicalRef)return model.canonicalRef;
    const modelRef=ref(model);
    return modelRef&&isGateway(model)?(nineRouter?.canonicalRef(modelRef)??modelRef):modelRef;
  };
  function readGatewayUsage(){
    if(!nineRouter?.enabled)return gatewayUsage;
    try{gatewayUsage=readNineRouterUsage(root)??gatewayUsage;}catch(error:any){log('ninerouter-usage-read-error',{errorType:error?.name??'Error'});}
    return gatewayUsage;
  }
  function usageSummary(cache:any){
    if(!cache)return undefined;
    const ageSeconds=Math.max(0,(Date.now()-cache.fetchedAt)/1000);
    const available=cache.fetchedAt>0&&ageSeconds*1000<=QUOTA_MAX_AGE_MS&&!cache.errors?.auth&&!cache.errors?.stats;
    return {scope:'instance',period:'today',costBasis:'nominal-estimate',fetchedAt:cache.fetchedAt,ageSeconds,available,total:available?cache.total:undefined,providers:Object.keys(cache.providers??{}),errors:cache.errors};
  }
  function refreshGatewayUsage(now=Date.now()){
    if(!nineRouter?.enabled||usageRefreshPromise||now-usageRefreshAt<NINE_ROUTER_REFRESH_THROTTLE_MS)return;
    usageRefreshAt=now;
    // 2500ms is the HTTP budget only; the secret read has its own timeout, so a
    // biometric cache miss no longer aborts the refresh mid-credential-fetch.
    usageRefreshPromise=Promise.resolve(refreshNineRouterUsage(root,{timeoutMs:2500})).then((cache:any)=>{gatewayUsage=cache;}).catch((error:any)=>{log('ninerouter-usage-refresh-error',{errorType:error?.name??'Error'});}).finally(()=>{usageRefreshPromise=undefined;});
  }
  function gatewayQuotaFor(model:any,cache:any){
    if(!isGateway(model))return undefined;
    const modelRef=ref(model);
    const description=modelRef?nineRouter?.describe(modelRef):undefined;
    const id=description?.canonicalRef??canonical(model)??model.id??modelRef;
    try{return gatewayQuota(id,cache)??{observedAt:Date.now(),state:'unknown'};}catch(error:any){log('ninerouter-quota-error',{errorType:error?.name??'Error',model:ref(model)});return {observedAt:Date.now(),state:'unknown'};}
  }
  const fanoutDir=join(root,'fanout');
  function ownAgentId(ctx:any):string|undefined{
    try{
      const direct=typeof ctx?.getAgentId==='function'?ctx.getAgentId():undefined;
      if(direct)return direct;
      const sessionFile=ctx?.sessionManager?.getSessionFile?.();
      if(sessionFile){
        const match=AgentRegistry.global().list().find((a:any)=>a.sessionFile===sessionFile);
        if(match)return match.id;
      }
      if(!child)return MAIN_AGENT_ID;
    }catch{}
    return undefined;
  }
  function fanoutSiblings(ctx:any):{agentId?:string;parentId?:string;siblings:Array<{canonicalRef:string;count:number}>}{
    try{
      const agentId=ownAgentId(ctx);
      if(!agentId)return{siblings:[]};
      const parentId=AgentRegistry.global().get(agentId)?.parentId;
      const siblings=readSiblings(fanoutDir,agentId,parentId);
      return{agentId,parentId,siblings};
    }catch{return{siblings:[]};}
  }
  nineRouter=installNineRouter(pi,{root,nativeStreamSimple:streamSimple,log});
  const diagnostics=installProviderDiagnostics(pi,{log,notify,changed:status});
  // Source of the last automatic decision, always visible: a silent fallback
  // from jev to rules is exactly the kind of failure that hides.
  let lastSource:'jev'|'rules'|undefined;
  function status() {
    const value=state.disabled?'manual':state.pin?'pin':'auto';
    const source=value==='auto'&&lastSource?` · ${lastSource}`:'';
    ctxCurrent?.ui.setStatus('personal-router',`route ${value}${source} · ${lastActual?.split('/').pop()??'ready'}${diagnostics.label?` · ${diagnostics.label}`:''}`);
  }
  function init(ctx:any) {
    ctxCurrent=ctx;
    const entries=ctx.sessionManager.getEntries();
    const nativeInit=entries.find((e:any)=>e.type==='session_init');
    child=!!nativeInit;
    state=[...ctx.sessionManager.getBranch()].reverse().find((e:any)=>e.type==='custom'&&e.customType==='personal-router-state')?.data??{};
    // A child inherits a floor from the parent's subagent role, not a user role.
    if(child&&!state.childFloor)state.childFloor=childFloorFor(nativeInit?.modelRole);
    if(!child && process.argv.some(a=>a==='--model'||a.startsWith('--model='))) state.pin={model:ref(ctx.model),effort:pi.getThinkingLevel()};
    lastActual=ref(ctx.model);
    readGatewayUsage();
    refreshGatewayUsage();
    status();
    log('loaded',{mode:ctx.mode,model:lastActual,manualPin:!!state.pin,childFloor:state.childFloor,enabled:settings().enabled!==false,gateway:nineRouter.enabled});
  }
  pi.on('session_start',(_e:any,ctx:any)=>init(ctx));
  pi.on('session_switch',(_e:any,ctx:any)=>init(ctx));
  pi.on('session_compact',()=>{state.phase=undefined;state.handoffReady=true;save();});

  pi.on('before_agent_start',async(event:any,ctx:any)=>{
    ctxCurrent=ctx; blocked=false;
    const cfg=settings();
    if(cfg.enabled===false||state.disabled){if(ctx.model?.provider==='openrouter'&&!ctx.model[GUARDED_OPENROUTER_MARKER])await pi.setModel(guardOpenRouterModel(ctx.model,guard.apiId));lastActual=ref(ctx.model);status();return;}
    try {
      readGatewayUsage();
      refreshGatewayUsage();
      const current=ref(ctx.models.current());
      if(lastActual&&current&&current!==lastActual&&!state.providerFailed){state.pin={model:current,effort:pi.getThinkingLevel()};}
      const gatewayRefs=nineRouter.enabled?nineRouter.models
        .filter((m:any)=>typeof m.canonicalRef==='string'&&REFS.includes(m.canonicalRef))
        .map((m:any)=>`${m.provider}/${m.id}`):[];
      const ids=new Set([...REFS,...gatewayRefs,...(cfg.paidFallbackEnabled?BACKUPS:[]),...(current?[current]:[]),...(state.pin?.model?[state.pin.model]:[])]);
      const available=ctx.models.list();
      const models=[...ids].map(id=>available.find((m:any)=>ref(m)===id)).filter(Boolean);
      const gatewayCache=readGatewayUsage();
      const [quotas,promotion,meridian]=await Promise.all([inspectQuotas(ctx,models.filter((m:any)=>!isGateway(m)&&(cfg.claudeAccountOwner!=='meridian'||m.provider!=='anthropic')),AbortSignal.timeout(18000)),getPromotion(join(root,'promotion.json')),cfg.claudeAccountOwner==='meridian'?inspectMeridian(models.filter((m:any)=>!isGateway(m)),join(root,'meridian-usage.json'),state.claudeProfile,state.unavailableProfiles):Promise.resolve(new Map())]);
      for(const [id,quota] of meridian)quotas.set(id,quota);
      for(const m of models){
        if(!isGateway(m))continue;
        quotas.set(ref(m),{quota:gatewayQuotaFor(m,gatewayCache),accountOwner:'gateway'});
      }
      const branch=ctx.sessionManager.getBranch();
      const messages=buildSessionContext(branch).messages;
      const reportedTokens=ctx.getContextUsage()?.tokens;
      const registeredTools=pi.getAllTools();
      const activeTools=contextTools(registeredTools,pi.getActiveTools());
      const initialTokens=Math.ceil((textLength(event.systemPrompt)+textLength(activeTools))/3);
      const contextTokens=(Number.isFinite(reportedTokens)&&reportedTokens>0?Math.max(reportedTokens,initialTokens):initialTokens+Math.ceil(textLength(messages)/3)) + Math.ceil(textLength(event.prompt)/3) + (event.images?.length??0)*8000;
      const needsImages=!!event.images?.length||messages.some(hasImage);
      const routeModels=models.map((m:any)=>{
        const modelRef=ref(m)!;
        const gateway=isGateway(m);
        const description=gateway?nineRouter.describe(modelRef):undefined;
        const canonicalRef=description?.canonicalRef??canonical(m);
        const unavailableUntil=state.unavailableModels?.[modelRef];
        const goModelId=canonicalRef?.startsWith('opencode-go/')?canonicalRef.slice('opencode-go/'.length):undefined;
        return {
          ref:modelRef,
          canonicalRef,
          gateway,
          // A gateway route is authenticated by its registered provider/keyfile,
          // never by a native account or the host's OAuth store.
          authenticated:gateway?description?.allowed===true&&nineRouter.isAllowed(modelRef):true,
          contextWindow:gateway?(description?.contextWindow??m.contextWindow):m.contextWindow,
          supportsImages:gateway?(description?.supportsImages===true):(m.provider==='openrouter'?false:(m.input?.includes('image')??false)),
          supportsTools:gateway?(description?.supportsTools===true):true,
          supportedEfforts:m.thinking?.efforts??(gateway?(description?.reasoning?['medium','high']:['off']):(m.reasoning?['medium','high']:['off'])),
          // OpenCode Go validation belongs to the canonical model id. This
          // keeps the safeguard intact when a gateway registration uses a
          // different wire ref (and when the host drops custom fields).
          validated:goModelId?{tools:cfg.goValidated?.includes(goModelId)??false,vision:cfg.goVisionValidated?.includes(goModelId)??false,reasoning:cfg.goValidated?.includes(goModelId)??false}:undefined,
          quota:unavailableUntil>Date.now()?{observedAt:Date.now(),state:'depleted',windows:[{id:'runtime-model-backoff',exhausted:true,resetsAt:unavailableUntil}]}:quotas.get(modelRef)?.quota,
          payg:gateway?(description?.payg===true):m.provider==='openrouter',
          qualityTiers:BACKUPS.includes(modelRef)?(m.id.includes('gpt-5.6-sol')?['mechanical','bounded','execution']:['mechanical','bounded','execution','complex','premium']):undefined,
        };
      });
      const contract=child && /(?:scope|escopo)\s*:/i.test(event.prompt) && /(?:acceptance|aceite|criterios? de aceite)\s*:/i.test(event.prompt);
      const input:any={prompt:event.prompt,now:Date.now(),models:routeModels,current:current?{model:current,effort:pi.getThinkingLevel(),tier:state.tier,phase:state.phase}:undefined,previous:state.tier?{tier:state.tier,phase:state.phase}:undefined,childFloor:state.childFloor,manualPin:state.pin,contextTokens,outputMarginTokens:8192,needsImages,needsTools:pi.getActiveTools().length>0,boundary:state.providerFailed?'provider-failure':child&&!state.tier?'child':'user',task:{bounded:contract,acceptanceDefined:contract,failedQualityChecks:state.failedQualityChecks??0,highValue:state.highValue},promotion,paidFallback:{authorized:false,budgetReserved:false,allowedModels:[]},handoffReady:state.handoffReady??false};
      input.hasWorkContext=messages.some((message:any)=>message?.role==='assistant');
      if(child&&!state.tier)input.siblings=fanoutSiblings(ctx).siblings;
      // Semantic classification: mode-gated, budget-gated, fail-closed. Shadow
      // records but never changes the executed decision. Classification only
      // happens at a safe boundary (here), never per tool-loop continuation.
      // auto = rules + Jev-assisted when a key exists. No key => rules only.
      // Pin and manual skip classification entirely; they never spend.
      const semantic=semanticSettings();
      const keyPresent=!state.disabled&&!state.pin&&!!(await typesafeKey());
      semanticMode=state.disabled||state.pin?'off':keyPresent?semantic.mode:'off';
      let semanticAssessment:SemanticAssessment|undefined;
      let semanticTrace:any;
      if(semanticMode!=='off'&&!state.pin){
        const routingContext=buildRoutingContext({
          taskGoal:state.taskGoal?String(state.taskGoal):String(event.prompt??'').slice(0,2000),
          currentUserRequest:String(event.prompt??''),
          previousPhase:state.phase,
          scope:child?String(event.prompt??'').slice(0,2000):undefined,
          acceptanceCriteria:contract?[String(event.prompt??'').slice(0,1500)]:undefined,
          recentEvidence:messages.filter((msg:any)=>msg?.role==='assistant').slice(-2).map((msg:any)=>typeof msg?.text==='string'?msg.text.slice(0,600):'').filter(Boolean),
          boundary:input.boundary==='child'?'child':input.boundary==='provider-failure'?'provider-failure':'user',
          hasImages:needsImages,
          toolsRequired:input.needsTools,
          confirmedQualityFailures:state.failedQualityChecks??0,
        });
        const hmacKey=process.env.OMP_ROUTER_HMAC_KEY??join(root,'keyring');
        const cacheKey=cacheKeyFor(routingContext,assessmentCacheKey({state:routingContext,schemaVersion:JEV_SCHEMA_VERSION,questionSetVersion:JEV_QUESTION_SET_VERSION,classifierModel:JEVS_CLASSIFIER_MODEL,hmacKey:typeof hmacKey==='string'?hmacKey:join(root,'keyring')}),JEV_QUESTION_SET_VERSION,JEVS_CLASSIFIER_MODEL,String(state.epoch??'global'));
        const cached=assessmentCache.get(cacheKey);
        if(cached){semanticAssessment=cached;}
        else{
          const result=await jev.assess(routingContext,cacheKey).catch(()=>({ok:false as const,reason:'transport' as const,elapsedMs:0}));
          semanticTrace={result:result.ok?'assessed':result.reason,elapsedMs:result.ok?result.elapsedMs:result.elapsedMs,mode:semanticMode,tierAssessed:result.ok?result.assessment.tier.selected:undefined,phaseAssessed:result.ok?result.assessment.phase.selected:undefined,truncated:routingContext.truncated};
          if(result.ok){assessmentCache.put(cacheKey,result.assessment);semanticAssessment=result.assessment;}
        }
      }
      const rulesClassification=state.tier&&state.phase?{tier:state.tier,phase:state.phase}:{tier:'complex' as RouteTier,phase:'investigation' as const};
      let semanticResolution:{tier:RouteTier;phase:typeof rulesClassification.phase;source:'rules'|'semantic-assisted'|'semantic-downgrade';reason:string}|undefined;
      if(semanticMode!=='off'&&semanticAssessment){
        semanticResolution=resolveClassification({assessment:semanticAssessment,rulesClassification,mode:semanticMode,floorTier:state.childFloor?.tier,floorLocksPhase:!!state.childFloor,highValue:state.highValue===true,failedQualityChecks:state.failedQualityChecks??0});
        if(semanticMode==='shadow'){
          semanticTrace={...(semanticTrace??{}),shadow:{baselineTier:rulesClassification.tier,semanticTier:semanticResolution.tier,proposedSource:semanticResolution.source}};
        } else if(semanticResolution.source!=='rules'){
          // Assisted/calibrated: the resolved classification steers the real decision.
          state={...state,tier:semanticResolution.tier,phase:semanticResolution.phase};
        }
      }
      if(semanticTrace)log('semantic-router',{...semanticTrace,cacheSize:assessmentCache.size});
      lastSemanticTrace=semanticTrace??lastSemanticTrace;
      // "jev" only when a usable assessment actually shaped the executed decision.
      lastSource=semanticResolution&&semanticResolution.source!=='rules'&&semanticMode!=='shadow'?'jev':'rules';
      let decision=decideRoute(input);
      if(input.boundary==='user'&&decision.model){
        const target=routeModels.find((m:any)=>m.ref===decision.model);
        const targetQuota=target?.quota;
        // Steering only makes sense for gateway routes: 9router owns the account choice.
        const wp=target?.gateway?(target.canonicalRef??'').split('/',1)[0]:'';
        const steerProvider=wp==='anthropic'?'claude':wp==='openai-codex'?'codex':wp==='opencode-go'?'opencode-go':undefined;
        if(targetQuota&&steerProvider&&Date.now()-(steerThrottle[steerProvider]??0)>=STEER_INTERVAL_MS){
          steerThrottle[steerProvider]=Date.now();
          const provider=steerProvider;
          steerAccounts({provider,snapshot:targetQuota,session:()=>nineRouterSession(),log}).catch(()=>{});
        }
      }
      if(decision.action==='unavailable'&&cfg.paidFallbackEnabled&&!state.pin){
        await reconcile(ctx);
        // This second pass proposes a candidate only. No switch/dispatch occurs until atomic reservation succeeds below.
        const proposed=decideRoute({...input,paidFallback:{authorized:true,budgetReserved:true,allowedModels:BACKUPS}});
        if(proposed.model?.startsWith('openrouter/')){
          const m=models.find((m:any)=>ref(m)===proposed.model);
          if(m){
            const id=randomUUID(),estimate=estimateUpperBoundUsd({inputTokens:contextTokens,maxOutputTokens:Math.min(m.maxTokens,32768),rates:priceCeiling(m)});
            const hold=budget().reserve(id,estimate);
            if(hold.ok){reservation={id,model:proposed.model,estimate,dispatched:false};decision=proposed;}
            else log('budget-blocked',{reason:hold.reason,estimateUsd:estimate});
          }
        }
      }
      lastStatus=decision;
      if(decision.action==='unavailable'||!decision.model){
        blocked=true;ctx.abort();log('blocked',{reason:decision.reason,rejected:decision.rejected,contextTokens});notify('Routing: nenhuma rota adequada disponível. /route status mostra o motivo; /route pin provider/model fixa uma alternativa.','warning');return;
      }
      let target=models.find((m:any)=>ref(m)===decision.model);
      if(!target){releaseUndispatched();blocked=true;ctx.abort();log('blocked',{reason:'selected-model-unavailable',model:decision.model});notify('Routing: catálogo da rota selecionada indisponível.','warning');return;}
      const q=quotas.get(decision.model); lastQuota=q;
      if(target?.provider==='openrouter')target=guardOpenRouterModel(target,guard.apiId);
      if(target.provider==='anthropic'&&cfg.claudeAccountOwner==='meridian')target=withMeridianProfile(target,q?.profile,ctx.sessionManager.getSessionId());
      if(target.provider!=='9router'&&q?.credentialId&&target.provider!=='opencode-go')ctx.modelRegistry.authStorage.pinSessionOAuthAccount(target.provider,ctx.sessionManager.getSessionId(),q.credentialId);
      if(decision.model!==current||(target.provider==='openrouter'&&!ctx.models.current()?.[GUARDED_OPENROUTER_MARKER])||(target.provider==='anthropic'&&cfg.claudeAccountOwner==='meridian'&&(state.claudeProfile!==q?.profile||ctx.models.current()?.headers?.['x-meridian-profile']!==q?.profile))){
        const ok=await pi.setModel(target);
        if(!ok){releaseUndispatched();blocked=true;ctx.abort();log('blocked',{reason:'native-setModel-unavailable',model:decision.model});notify('Routing: autenticação da rota selecionada indisponível.','warning');return;}
      }
      if(decision.effort&&!state.pin?.effort)pi.setThinkingLevel(decision.effort);
      state={...state,tier:decision.tier,phase:decision.phase,providerFailed:false,handoffReady:false,...(q?.profile?{claudeProfile:q.profile}:{})};
      lastActual=ref(ctx.models.current())??decision.model;
      save();status();
      try{
        const agentId=ownAgentId(ctx);
        if(agentId){
          const ownCanonical=routeModels.find((m:any)=>m.ref===lastActual)?.canonicalRef??canonical(lastActual);
          const childrenMap:Record<string,string>={};
          for(const a of AgentRegistry.global().list()){
            if(a.parentId!==agentId||a.status!=='running'||a.id===agentId)continue;
            const childCanonical=a.session?canonical(a.session.model):undefined;
            if(childCanonical)childrenMap[a.id]=childCanonical;
          }
          writeFanout(fanoutDir,agentId,ownCanonical??lastActual,childrenMap);
          const siblingInfo=fanoutSiblings(ctx);
          log('fanout',{agentId,parentId:siblingInfo.parentId,siblings:siblingInfo.siblings});
        }
      }catch{}
      const active=target.provider==='9router'?undefined:ctx.modelRegistry.authStorage.listOAuthAccounts(target.provider,ctx.sessionManager.getSessionId()).find((a:any)=>a.active);
      const requestedCanonicalModel=routeModels.find((m:any)=>m.ref===decision.model)?.canonicalRef??decision.model;
      const actualCanonicalModel=routeModels.find((m:any)=>m.ref===lastActual)?.canonicalRef??canonical(lastActual);
      log('decision',{requestedModel:decision.model,requestedWireModel:decision.model,requestedCanonicalModel,actualModel:lastActual,actualWireModel:lastActual,actualCanonicalModel,effort:pi.getThinkingLevel(),reason:decision.reason,tier:decision.tier,phase:decision.phase,contextTokens,needsImages,preferredCredentialId:target.provider==='9router'?undefined:q?.credentialId,actualCredentialId:target.provider==='9router'?undefined:q?.accountOwner==='meridian'?undefined:active?.credentialId,preferredProfile:q?.profile,accountOwner:target.provider==='9router'?'gateway':q?.accountOwner??'omp-native',quota:q?.quota,promotion:{active:promotion.active,confirmedAt:promotion.confirmedAt},rejected:decision.rejected});
    }catch(error:any){
      releaseUndispatched();blocked=true;ctx.abort();log('router-error',{errorType:error?.name??'Error'});notify('Routing: falha de verificação. A chamada foi interrompida; /route off mantém o controle manual.','error');
    }
  });

  pi.on('before_provider_request',(_event:any,ctx:any)=>{
    const m=ctx.model??ctx.models.current();if(m?.provider!=='openrouter')return;
    releaseUndispatched();
    if(!m[GUARDED_OPENROUTER_MARKER]){blocked=true;ctx.abort();log('budget-blocked',{reason:'unguarded-openrouter-transport'});notify('OpenRouter: transporte sem proteção de orçamento; chamada interrompida.','warning');}
  });
  pi.on('message_end',async(event:any,ctx:any)=>{
    if(event.message?.role!=='assistant')return;
    const m=event.message;
    const actual=m.provider&&m.model?`${m.provider}/${m.model}`:ref(ctx.models.current());
    lastActual=actual;
    const gatewayResponse=m.provider==='9router';
    const active=gatewayResponse?undefined:ctx.modelRegistry.authStorage.listOAuthAccounts(m.provider??ctx.model?.provider,ctx.sessionManager.getSessionId()).find((a:any)=>a.active);
    const actualCanonicalModel=canonical(actual);
    log('response',{actualModel:actual,actualWireModel:actual,actualCanonicalModel,actualCredentialId:gatewayResponse||m.provider==='anthropic'&&settings().claudeAccountOwner==='meridian'?undefined:active?.credentialId,accountOwner:gatewayResponse?'gateway':m.provider==='anthropic'?settings().claudeAccountOwner??'omp-native':'omp-native',preferredProfile:m.provider==='anthropic'?state.claudeProfile:undefined,stopReason:m.stopReason,usage:m.usage?{input:m.usage.input,output:m.usage.output,cacheRead:m.usage.cacheRead,cacheWrite:m.usage.cacheWrite,nominalCost:m.usage.cost?.total}:undefined});
    if(m.provider==='openrouter')await reconcile(ctx);
    if(m.stopReason==='error'){
      state.providerFailed=true;
      if(m.provider==='anthropic'&&state.claudeProfile){state.unavailableProfiles={...state.unavailableProfiles,[state.claudeProfile]:Date.now()+180000};}
      else state.unavailableModels={...state.unavailableModels,[actual]:Date.now()+180000};
      save();
    } else if(m.stopReason==='stop'||m.stopReason==='toolUse'){
      state.providerFailed=false;
      if(state.unavailableModels)delete state.unavailableModels[actual];
      if(m.provider==='anthropic'&&state.claudeProfile&&state.unavailableProfiles)delete state.unavailableProfiles[state.claudeProfile];
      save();
    }
  });
  pi.on('agent_end',()=>{
    releaseUndispatched();
    status();
  });
  pi.on('session_shutdown',()=>{
    try{const agentId=ownAgentId(ctxCurrent);if(agentId)removeFanout(fanoutDir,agentId);}catch{}
    nineRouter.dispose();guard.dispose();releaseUndispatched();ledger?.close();ledger=undefined;});

  pi.registerCommand('route',{
    description:'Routing: status | auto | off | pin provider/model | key [status|clear] | why | feedback fail/success | handoff | high-value',
    handler:async(args:string,ctx:any)=>{
      ctxCurrent=ctx;
      const normalized=args.trim();
      const [cmd,...rest]=(normalized?normalized:'status').split(/\s+/);
      if(cmd==='auto'){state.pin=undefined;state.tier=undefined;state.phase=undefined;state.disabled=false;state.providerFailed=false;const assisted=!!(await typesafeKey());notify(assisted?'Auto: regras + Jev.':'Auto: só regras. /route key liga o Jev.');}
      else if(cmd==='off'){state.disabled=true;notify('Routing manual nesta sessão. /route auto reativa.');}
      else if(cmd==='pin'){
        const resolved=ctx.models.resolve(rest[0]??'');
        const target=resolved?guardOpenRouterModel(resolved,guard.apiId):undefined;
        if(!target){notify('Modelo não encontrado no catálogo autenticado.','warning');return;}
        if(isGateway(target)&&!nineRouter.isAllowed(ref(target)!)){notify('Modelo 9Router não está autorizado para transporte.','warning');return;}
        if(!(await pi.setModel(target))){notify('Modelo sem autenticação disponível.','warning');return;}
        state.pin={model:ref(target),effort:pi.getThinkingLevel()};state.disabled=false;lastActual=ref(target);notify(`Modelo fixado: ${lastActual}`);
      }else if(cmd==='feedback'){
        state.failedQualityChecks=rest[0]==='fail'?(state.failedQualityChecks??0)+1:0;notify(`Falhas de aceite registradas: ${state.failedQualityChecks}.`);
      }else if(cmd==='handoff'){state.handoffReady=true;state.phase=undefined;notify('Estado de trabalho preparado; próxima solicitação pode mudar de modelo/família.');}
      else if(cmd==='high-value'){state.highValue=!state.highValue;notify(`Uso de reserva para tarefa de alto valor: ${state.highValue?'ativo':'inativo'}.`);}
      else if(cmd==='usage'){notify(JSON.stringify({gateway:nineRouter.enabled,gatewayUsage:usageSummary(readGatewayUsage())},null,2));return;}
      else if(cmd==='refresh'){
        if(!nineRouter.enabled){notify('Telemetria 9Router indisponível.','warning');return;}
        usageRefreshAt=0;
        try{gatewayUsage=await refreshNineRouterUsage(root,{timeoutMs:15000,force:true});log('ninerouter-usage-refreshed',usageSummary(gatewayUsage));notify(JSON.stringify(usageSummary(gatewayUsage),null,2));}
        catch(error:any){log('ninerouter-usage-refresh-error',{errorType:error?.name??'Error'});notify('Telemetria 9Router indisponível.','warning');}
        return;
      }
      else if(cmd==='key'){
        // One-time setup. The key is read straight from 1Password (`op`) into
        // omp's credential store, the same place every other provider key
        // lives, so it survives shells and restarts. It is deliberately NOT a
        // command argument: omp persists slash commands verbatim in history.db,
        // so `/route key <secret>` would write the secret to disk forever.
        const auth=ctx.modelRegistry?.authStorage;
        if(!auth?.set){notify('Cofre de credenciais indisponível nesta sessão.','warning');return;}
        const sub=rest[0];
        if(sub==='clear'){await auth.remove(TYPESAFE_PROVIDER);assessmentCache.clear();notify('Chave TypeSafe removida do cofre.');log('command',{command:'key',action:'clear'});return;}
        if(sub==='status'){const present=!!(await typesafeKey());notify(present?'Chave TypeSafe presente.':'Nenhuma chave TypeSafe.');return;}
        if(sub!==undefined){notify('Uso: /route key | status | clear. A chave vem do 1Password, nunca do argumento.','warning');return;}
        let key='';
        try{key=(await readTypesafeKeyFromOp()).trim();}
        catch(error:any){log('command',{command:'key',action:'import-failed',errorType:error?.name??'Error'});notify('Não consegui ler a chave do 1Password (item "AgentKit - Typesafe"). O 1Password pode pedir Touch ID.','warning');return;}
        if(!/^apikey_[A-Za-z0-9_-]{20,}$/.test(key)){notify('Chave lida do 1Password tem formato inesperado; nada gravado.','warning');return;}
        await auth.set(TYPESAFE_PROVIDER,{type:'api_key',key,source:'login'});
        assessmentCache.clear();
        notify(`Chave TypeSafe importada (${key.slice(0,10)}…, ${key.length} chars). Auto agora é regras + Jev.`);
        log('command',{command:'key',action:'import',prefix:key.slice(0,7),length:key.length});
        return;
      }
      else if(cmd==='reconcile'){await reconcile(ctx);notify(JSON.stringify(budget().snapshot(),null,2));return;}
      else if(cmd==='why'||cmd==='explain'){
        // One deterministic sentence built from validated fields; nothing generated.
        if(state.disabled){notify('Manual: routing desligado nesta sessão; o modelo atual é o que você escolheu.');return;}
        if(state.pin){notify(`Manual: fixado em ${state.pin.model}; routing automático não se aplica.`);return;}
        const d=lastStatus;
        if(!d){notify('Auto: nenhuma decisão ainda nesta sessão.');return;}
        const trace=lastSemanticTrace;
        const jev=trace?.result==='assessed'?`Jev avaliou ${trace.tierAssessed}/${trace.phaseAssessed}${trace.truncated?' (contexto truncado)':''}`:trace?.result?`Jev indisponível (${trace.result})`:semanticMode==='off'?'Jev sem chave (/route key liga)':'Jev não consultado';
        const origin=lastSource==='jev'?'e a avaliação moldou a decisão':lastSource==='rules'&&trace?.result==='assessed'?'mas as regras prevaleceram':'; regras determinísticas decidiram';
        const chosen=d.model?`${d.model.split('/').pop()} (${d.tier}, ${d.phase})`:'nenhuma rota';
        const quota=d.quotaState?`, quota ${d.quotaState}`:'';
        notify(`Auto: ${chosen}${quota}. ${jev} ${origin}. ${d.reason}`);
        return;
      }
      else {notify(JSON.stringify({version:VERSION,enabled:settings().enabled!==false,manual:!!state.disabled,childFloor:state.childFloor,pin:state.pin,child,current:ref(ctx.models.current()),decision:lastStatus,providerFailure:diagnostics.failure,quota:lastQuota?.quota,gateway:nineRouter.enabled,gatewayUsage:usageSummary(readGatewayUsage()),semantic:{mode:semanticSettings().mode,effective:semanticMode,last:lastSemanticTrace},blocked,budget:budget().snapshot(),logs:join(root,'events.jsonl')},null,2));return;}
      save();status();log('command',{command:cmd,pin:state.pin?.model,disabled:!!state.disabled});
    }
  });
}
