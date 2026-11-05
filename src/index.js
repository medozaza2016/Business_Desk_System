const JSON_HEADERS = {"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const enc = new TextEncoder();
const json = (body,status=200,extra={}) => new Response(JSON.stringify(body),{status,headers:{...JSON_HEADERS,...extra}});
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const randomToken = (n=32) => { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
const sha256 = async s => b64url(await crypto.subtle.digest("SHA-256",enc.encode(s)));
const passwordHash = async (password,salt,iterations=210000) => {
 const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
 return b64url(await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations,hash:"SHA-256"},key,256));
};
const parseCookie = (request,name) => (request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="))?.slice(name.length+1);
const bodyJson = async req => { try { return await req.json(); } catch { return null; } };
const validEmail = s => typeof s==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length<=254;
const slugify = s => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,50);
async function currentAdmin(request,env){
 const token=parseCookie(request,"q_session"); if(!token)return null;
 const row=await env.DB.prepare("SELECT a.id,a.email FROM sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?").bind(await sha256(token),Math.floor(Date.now()/1000)).first();
 return row||null;
}
async function handleApi(request,env,url){
 if(url.pathname==="/api/health" && request.method==="GET"){
  try{const r=await env.DB.prepare("SELECT 1 AS ok").first();return json({ok:r?.ok===1,service:"challenger-quotation-platform",version:"0.2.0"});}
  catch{return json({ok:false,error:"database_unavailable"},503);}
 }
 if(url.pathname==="/api/setup" && request.method==="POST"){
  if(!env.BOOTSTRAP_SECRET)return json({error:"setup_secret_not_configured"},503);
  const body=await bodyJson(request); if(!body||request.headers.get("x-setup-secret")!==env.BOOTSTRAP_SECRET)return json({error:"unauthorized"},401);
  if(!validEmail(body.email)||typeof body.password!=="string"||body.password.length<14)return json({error:"valid_email_and_password_minimum_14_characters_required"},400);
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first();
  if(count.n>0)return json({error:"setup_already_completed"},409);
  const id=crypto.randomUUID(),salt=randomToken(16),hash=await passwordHash(body.password,salt);
  await env.DB.prepare("INSERT INTO admin_users(id,email,password_salt,password_hash) VALUES(?,?,?,?)").bind(id,body.email,salt,hash).run();
  return json({created:true,message:"Administrator created. Sign in at /api/auth/login"},201);
 }
 if(url.pathname==="/api/auth/login" && request.method==="POST"){
  const body=await bodyJson(request);if(!body||!validEmail(body.email)||typeof body.password!=="string")return json({error:"invalid_credentials"},400);
  const ip=request.headers.get("CF-Connecting-IP")||"unknown",ipHash=await sha256(ip),now=Math.floor(Date.now()/1000);
  await env.DB.prepare("DELETE FROM login_attempts WHERE attempted_at<?").bind(now-900).run();
  const attempts=await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash=? AND attempted_at>?").bind(ipHash,now-900).first();
  if(attempts.n>=10)return json({error:"too_many_attempts"},429);
  await env.DB.prepare("INSERT INTO login_attempts(ip_hash,attempted_at) VALUES(?,?)").bind(ipHash,now).run();
  const admin=await env.DB.prepare("SELECT id,email,password_salt,password_hash,password_iterations FROM admin_users WHERE email=? COLLATE NOCASE").bind(body.email).first();
  const actual=admin?await passwordHash(body.password,admin.password_salt,admin.password_iterations):await passwordHash(body.password,"dummy-salt");
  if(!admin||actual!==admin.password_hash)return json({error:"invalid_credentials"},401);
  const token=randomToken(32),expires=now+SESSION_SECONDS;
  await env.DB.prepare("INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)").bind(await sha256(token),admin.id,expires).run();
  await env.DB.prepare("UPDATE admin_users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").bind(admin.id).run();
  return json({authenticated:true,admin:{id:admin.id,email:admin.email}},{status:200,headers:{"set-cookie":`q_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`}});
 }
 if(url.pathname==="/api/auth/logout" && request.method==="POST"){
  const token=parseCookie(request,"q_session");if(token)await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
  return json({authenticated:false},{headers:{"set-cookie":"q_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"}});
 }
 if(url.pathname==="/api/auth/me" && request.method==="GET"){
  const admin=await currentAdmin(request,env);return json({authenticated:!!admin,admin:admin||null});
 }
 const admin=await currentAdmin(request,env);if(!admin)return json({error:"unauthorized"},401);
 if(url.pathname==="/api/companies" && request.method==="GET"){
  const result=await env.DB.prepare("SELECT id,name,slug,legal_name,phone,email,address,quotation_prefix,currency,logo_key,letterhead_key,font_name,active,created_at FROM companies ORDER BY name").all();
  return json({companies:result.results});
 }
 if(url.pathname==="/api/companies" && request.method==="POST"){
  const body=await bodyJson(request);
  if(!body||typeof body.name!=="string"||body.name.trim().length<2||body.name.length>120)return json({error:"company_name_required"},400);
  const slug=slugify(body.slug||body.name);if(!slug)return json({error:"invalid_company_slug"},400);
  const id=crypto.randomUUID();
  try{
   await env.DB.prepare("INSERT INTO companies(id,name,slug,legal_name,phone,email,address,quotation_prefix,currency) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id,body.name.trim(),slug,String(body.legal_name||""),String(body.phone||""),String(body.email||""),String(body.address||""),String(body.quotation_prefix||"QA-").slice(0,12),String(body.currency||"AED").slice(0,3)).run();
  }catch(e){return json({error:"company_slug_already_exists_or_invalid"},409);}
  return json({company:{id,name:body.name.trim(),slug}},201);
 }
 if(url.pathname==="/api/companies" && request.method==="DELETE"){
  const id=url.searchParams.get("id");if(!id)return json({error:"company_id_required"},400);
  await env.DB.prepare("UPDATE companies SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  return json({deactivated:true});
 }
 return json({error:"not_found"},404);
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname.startsWith("/api/")){
  try{return await handleApi(request,env,url);}catch(e){return json({error:"internal_error"},500);}
 }
 return env.STATIC.fetch(request);
}};