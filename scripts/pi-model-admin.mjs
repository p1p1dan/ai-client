#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = resolve(
  process.env.PILAB_MODEL_ADMIN_DATA || `${root}/model-admin/models-config.json`
);
const host = process.env.PILAB_MODEL_ADMIN_HOST || '127.0.0.1';
const port = Number(process.env.PILAB_MODEL_ADMIN_PORT || 3210);
const adminToken = process.env.PILAB_MODEL_ADMIN_TOKEN || '';
const maxBodyBytes = 2 * 1024 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function loadConfig() {
  if (!existsSync(dataPath)) throw new Error(`Config file does not exist: ${dataPath}`);
  return JSON.parse(readFileSync(dataPath, 'utf8'));
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== 1)
    throw new Error('version must be 1');
  if (!value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
    throw new Error('providers must be an object');
  }
  const providerIds = Object.keys(value.providers);
  if (providerIds.length === 0) throw new Error('at least one provider is required');
  for (const providerId of providerIds) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId))
      throw new Error(`invalid provider id: ${providerId}`);
    const provider = value.providers[providerId];
    if (!provider || typeof provider !== 'object')
      throw new Error(`${providerId} must be an object`);
    for (const forbidden of ['apiKey', 'key', 'token', 'oauth']) {
      if (forbidden in provider)
        throw new Error(
          `${providerId}.${forbidden} is forbidden; keys never belong in models config`
        );
    }
    const url = new URL(provider.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error(`${providerId}.baseUrl must use http/https`);
    if (
      ![
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai',
      ].includes(provider.api)
    ) {
      throw new Error(`${providerId}.api is unsupported`);
    }
    if (!Array.isArray(provider.models) || provider.models.length === 0)
      throw new Error(`${providerId} needs at least one model`);
    const seen = new Set();
    for (const model of provider.models) {
      if (!model || typeof model.id !== 'string' || !model.id.trim())
        throw new Error(`${providerId} has a model without id`);
      if (seen.has(model.id)) throw new Error(`${providerId} contains duplicate model ${model.id}`);
      seen.add(model.id);
      for (const forbidden of ['apiKey', 'key', 'token']) {
        if (forbidden in model)
          throw new Error(`${providerId}/${model.id}.${forbidden} is forbidden`);
      }
    }
  }
  return { ...value, updatedAt: new Date().toISOString() };
}

function saveConfig(value) {
  const validated = validateConfig(value);
  mkdirSync(dirname(dataPath), { recursive: true });
  const tmp = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  renameSync(tmp, dataPath);
  return validated;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('request exceeds 2 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authorized(req) {
  if (!adminToken) return true;
  return req.headers.authorization === `Bearer ${adminToken}`;
}

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PILAB 模型管理</title><style>
:root{font-family:Inter,system-ui,sans-serif;color:#252521;background:#f7f4ec}*{box-sizing:border-box}body{margin:0}.shell{max-width:1120px;margin:0 auto;padding:32px 20px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:22px}h1{font-size:24px;margin:0 0 7px}p{color:#6d6b66;margin:0}.badge{padding:6px 10px;border:1px solid #d8d4c9;border-radius:8px;background:#fffdf4;font-size:13px}.card{background:#fffdf4;border:1px solid #d8d4c9;border-radius:14px;padding:18px;margin-bottom:14px}.row{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.field{grid-column:span 4}.field.wide{grid-column:span 8}label{display:block;font-size:12px;color:#6d6b66;margin-bottom:6px}input,select,textarea{width:100%;border:1px solid #cecabf;background:white;border-radius:8px;padding:9px 10px;font:inherit;color:inherit}textarea{font-family:ui-monospace,monospace;min-height:360px;line-height:1.5}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar.end{justify-content:flex-end}button{border:1px solid #c7c2b7;background:#fff;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600}button.primary{background:#bc5215;color:white;border-color:#bc5215}button.danger{color:#af3029}.models{margin-top:14px;border-top:1px solid #e1ddd3;padding-top:14px}.model{display:grid;grid-template-columns:2fr 2fr 1fr 1fr auto;gap:8px;margin:8px 0;align-items:center}.status{font-size:13px;min-height:20px;color:#66800b}.status.error{color:#af3029}.token{max-width:260px}@media(max-width:760px){.field,.field.wide{grid-column:1/-1}.model{grid-template-columns:1fr}.top{display:block}.badge{margin-top:12px}}
</style></head><body><div class="shell"><div class="top"><div><h1>PILAB 模型管理</h1><p>维护公司模型元数据。API key 不会写入这里，由客户端登录后注入。</p></div><div class="badge">GET /api/v1/models-config</div></div>
<div class="toolbar" style="margin-bottom:14px"><input id="token" class="token" type="password" placeholder="管理 Token（本地可留空）"><button id="reload">重新加载</button><button id="addProvider">新增渠道</button><button id="jsonToggle">JSON 编辑</button><span id="status" class="status"></span></div>
<div id="forms"></div><div id="jsonCard" class="card" hidden><label>完整配置 JSON</label><textarea id="json"></textarea></div>
<div class="toolbar end"><button id="save" class="primary">保存并发布</button></div></div>
<script>
const apis=['openai-completions','openai-responses','anthropic-messages','google-generative-ai'];let config={version:1,providers:{}};let jsonMode=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function status(text,error=false){const el=document.querySelector('#status');el.textContent=text;el.className='status'+(error?' error':'')}
function render(){const root=document.querySelector('#forms');root.innerHTML='';Object.entries(config.providers).forEach(([id,p])=>{const card=document.createElement('div');card.className='card';card.dataset.provider=id;card.innerHTML='<div class="row"><div class="field"><label>渠道 ID</label><input data-f="id" value="'+esc(id)+'"></div><div class="field"><label>显示名称</label><input data-f="name" value="'+esc(p.name||'')+'"></div><div class="field wide"><label>Base URL</label><input data-f="baseUrl" value="'+esc(p.baseUrl||'')+'"></div><div class="field"><label>API 协议</label><select data-f="api">'+apis.map(a=>'<option '+(a===p.api?'selected':'')+'>'+a+'</option>').join('')+'</select></div><div class="field"><label>认证头</label><select data-f="authHeader"><option value="true" '+(p.authHeader!==false?'selected':'')+'>Bearer</option><option value="false" '+(p.authHeader===false?'selected':'')+'>自定义</option></select></div></div><div class="models"><div class="toolbar"><strong>模型</strong><button data-action="addModel">新增模型</button><button class="danger" data-action="removeProvider">删除渠道</button></div><div class="modelRows"></div></div>';const rows=card.querySelector('.modelRows');(p.models||[]).forEach((m,i)=>rows.appendChild(modelRow(m,i)));root.appendChild(card)});document.querySelector('#json').value=JSON.stringify(config,null,2)}
function modelRow(m,i){const row=document.createElement('div');row.className='model';row.dataset.index=i;row.innerHTML='<input data-mf="id" placeholder="模型 ID" value="'+esc(m.id||'')+'"><input data-mf="name" placeholder="显示名称" value="'+esc(m.name||'')+'"><input data-mf="contextWindow" type="number" placeholder="上下文" value="'+esc(m.contextWindow||'')+'"><select data-mf="reasoning"><option value="true" '+(m.reasoning?'selected':'')+'>思考</option><option value="false" '+(!m.reasoning?'selected':'')+'>普通</option></select><button class="danger" data-action="removeModel">删除</button>';return row}
function collect(){if(jsonMode){config=JSON.parse(document.querySelector('#json').value);return}const providers={};document.querySelectorAll('[data-provider]').forEach(card=>{const old=card.dataset.provider;const id=card.querySelector('[data-f=id]').value.trim();const p=config.providers[old]||{};const models=[];card.querySelectorAll('.model').forEach(row=>{const oldModel=(p.models||[])[Number(row.dataset.index)]||{};const context=Number(row.querySelector('[data-mf=contextWindow]').value);models.push({...oldModel,id:row.querySelector('[data-mf=id]').value.trim(),name:row.querySelector('[data-mf=name]').value.trim()||undefined,reasoning:row.querySelector('[data-mf=reasoning]').value==='true',...(context>0?{contextWindow:context}:{})})});providers[id]={...p,name:card.querySelector('[data-f=name]').value.trim()||undefined,baseUrl:card.querySelector('[data-f=baseUrl]').value.trim(),api:card.querySelector('[data-f=api]').value,authHeader:card.querySelector('[data-f=authHeader]').value==='true',models}});config={...config,version:1,providers}}
async function load(){try{const r=await fetch('/api/v1/models-config',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);config=await r.json();render();status('已加载 '+Object.keys(config.providers).length+' 个渠道')}catch(e){status(e.message,true)}}
async function save(){try{collect();const token=document.querySelector('#token').value;const r=await fetch('/api/v1/models-config',{method:'PUT',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(config)});const body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));config=body;render();status('保存成功 · '+new Date(config.updatedAt).toLocaleString())}catch(e){status(e.message,true)}}
document.addEventListener('click',e=>{const action=e.target.dataset.action;if(action==='addModel'){collect();const id=e.target.closest('[data-provider]').dataset.provider;config.providers[id].models.push({id:'new-model',name:'New Model',reasoning:false,contextWindow:128000,maxTokens:16384});render()}if(action==='removeProvider'){collect();delete config.providers[e.target.closest('[data-provider]').dataset.provider];render()}if(action==='removeModel'){collect();const card=e.target.closest('[data-provider]');config.providers[card.dataset.provider].models.splice(Number(e.target.closest('.model').dataset.index),1);render()}});
document.querySelector('#reload').onclick=load;document.querySelector('#save').onclick=save;document.querySelector('#addProvider').onclick=()=>{collect();let i=1,id='provider';while(config.providers[id])id='provider-'+(++i);config.providers[id]={name:'New Provider',baseUrl:'http://127.0.0.1:4000/v1',api:'openai-responses',authHeader:true,models:[{id:'model-id',name:'Model',reasoning:true,contextWindow:128000,maxTokens:16384}]};render()};document.querySelector('#jsonToggle').onclick=()=>{if(!jsonMode)collect();jsonMode=!jsonMode;document.querySelector('#forms').hidden=jsonMode;document.querySelector('#jsonCard').hidden=!jsonMode;document.querySelector('#jsonToggle').textContent=jsonMode?'表单编辑':'JSON 编辑';if(jsonMode)document.querySelector('#json').value=JSON.stringify(config,null,2);else{try{config=JSON.parse(document.querySelector('#json').value);render()}catch(e){jsonMode=true;status(e.message,true)}}};load();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/')
      return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/health')
      return send(res, 200, JSON.stringify({ ok: true }));
    if (req.method === 'GET' && url.pathname === '/api/v1/models-config')
      return send(res, 200, JSON.stringify(loadConfig()));
    if (req.method === 'PUT' && url.pathname === '/api/v1/models-config') {
      if (!authorized(req)) return send(res, 401, JSON.stringify({ error: 'unauthorized' }));
      const saved = saveConfig(JSON.parse(await readBody(req)));
      return send(res, 200, JSON.stringify(saved));
    }
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (error) {
    return send(
      res,
      400,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    );
  }
});
server.listen(port, host, () => {
  console.log(`[pi-model-admin] http://${host}:${port}`);
  console.log(`[pi-model-admin] data: ${dataPath}`);
  if (!adminToken && host !== '127.0.0.1' && host !== 'localhost')
    console.warn(
      '[pi-model-admin] WARNING: set PILAB_MODEL_ADMIN_TOKEN before exposing this server'
    );
});
