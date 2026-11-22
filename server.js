const http=require("node:http"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const ROOT="meowmaster100",PORT=+process.env.PORT||8080,DATA=process.env.DATA_DIR||"/tmp/catchat";
const ADMIN_PW=process.env.ADMIN_PASSWORD||"110921-fury";
if(ADMIN_PW.length<6){console.error("Set ADMIN_PASSWORD (6+ characters), add it under Environment on your host");process.exit(1)}
fs.mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(path.join(DATA,"meow.db"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY,name TEXT,salt TEXT,hash TEXT,coins INTEGER DEFAULT 100,admin INTEGER DEFAULT 0,banned INTEGER DEFAULT 0,inv TEXT DEFAULT '{}',daily INTEGER DEFAULT 0,avatar TEXT DEFAULT '{}',photo TEXT DEFAULT '',pv INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,emoji TEXT,descr TEXT,price INTEGER,stock INTEGER);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,text TEXT,ts INTEGER,sys INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,pid TEXT,ts INTEGER);
CREATE TABLE IF NOT EXISTS blocked(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS cats(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,img TEXT DEFAULT '',hp INTEGER);
CREATE TABLE IF NOT EXISTS moves(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,damage INTEGER,anim TEXT,price INTEGER);`);
try{db.exec("ALTER TABLE items ADD COLUMN img TEXT DEFAULT ''")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN moves TEXT DEFAULT '[]'")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN cats TEXT DEFAULT '[]'")}catch(e){}
try{db.exec("ALTER TABLE cats ADD COLUMN price INTEGER DEFAULT 0")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN kind TEXT DEFAULT 'normal'")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN infinite INTEGER DEFAULT 0");db.exec("UPDATE players SET infinite=1 WHERE id='meowmaster100'")}catch(e){}
try{db.exec("ALTER TABLE items ADD COLUMN seller TEXT DEFAULT ''")}catch(e){}
try{db.exec("ALTER TABLE moves ADD COLUMN fx TEXT DEFAULT ''")}catch(e){}
try{db.exec("ALTER TABLE players ADD COLUMN eq TEXT DEFAULT NULL")}catch(e){}
db.exec("CREATE TABLE IF NOT EXISTS badwords(w TEXT PRIMARY KEY)");
try{db.exec("ALTER TABLE items ADD COLUMN cap INTEGER DEFAULT 0")}catch(e){}
try{db.exec("ALTER TABLE moves ADD COLUMN owner TEXT DEFAULT ''")}catch(e){}
try{db.exec("ALTER TABLE cats ADD COLUMN owner TEXT DEFAULT ''")}catch(e){}
for(const c of["ALTER TABLE items ADD COLUMN hidden INTEGER DEFAULT 0","ALTER TABLE cats ADD COLUMN hidden INTEGER DEFAULT 0","ALTER TABLE moves ADD COLUMN hidden INTEGER DEFAULT 0","ALTER TABLE items ADD COLUMN rarity TEXT DEFAULT ''","ALTER TABLE cats ADD COLUMN rarity TEXT DEFAULT ''","ALTER TABLE moves ADD COLUMN rarity TEXT DEFAULT ''","ALTER TABLE moves ADD COLUMN type TEXT DEFAULT 'normal'","ALTER TABLE cats ADD COLUMN t1 TEXT DEFAULT 'normal'","ALTER TABLE cats ADD COLUMN t2 TEXT DEFAULT ''","ALTER TABLE cats ADD COLUMN evo TEXT DEFAULT ''","ALTER TABLE cats ADD COLUMN po INTEGER DEFAULT 0","ALTER TABLE players ADD COLUMN cx TEXT DEFAULT '{}'","ALTER TABLE players ADD COLUMN noscratch INTEGER DEFAULT 0","ALTER TABLE players ADD COLUMN eqc TEXT DEFAULT NULL"])try{db.exec(c)}catch(e){}
db.exec("CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,pid TEXT,text TEXT,ts INTEGER)");
db.exec("CREATE TABLE IF NOT EXISTS news(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,body TEXT,name TEXT,ts INTEGER)");
const MAX_SELL=5;
const q=s=>db.prepare(s);

// ---- persistence: the host's disk is wiped when the server sleeps, so the whole
// database is copied to Supabase (one row) after changes and loaded back on startup.
const SB_URL=(process.env.SUPABASE_URL||"").replace(/\/+$/,""),SB_KEY=process.env.SUPABASE_SERVICE_KEY||"",SB_ON=!!(SB_URL&&SB_KEY);
const TABLES=["players","items","messages","sessions","blocked","cats","moves","notes","badwords","news"];
const sb=(method,p,body)=>fetch(SB_URL+"/rest/v1/"+p,{method,headers:{apikey:SB_KEY,...(SB_KEY.startsWith("eyJ")?{Authorization:"Bearer "+SB_KEY}:{}),"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:body&&JSON.stringify(body)});
const EXTRA={};  // tables in the backup that this server doesn't know about: kept and written back untouched
const dump=()=>{const o={...EXTRA};for(const t of TABLES)o[t]=db.prepare("SELECT * FROM "+t).all();return o};
async function restore(){
 if(!SB_ON){console.warn("WARNING: SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Data will be lost when the server sleeps.");return}
 for(let i=0;i<5;i++){
  try{
   const r=await sb("GET","backup?id=eq.1&select=data");
   if(!r.ok)throw new Error(r.status+" "+await r.text());
   const rows=await r.json();
   if(rows.length){const d=rows[0].data||{};
    for(const t of Object.keys(d))if(!TABLES.includes(t))EXTRA[t]=d[t];
    for(const t of TABLES){const have=new Set(db.prepare("PRAGMA table_info("+t+")").all().map(r=>r.name));
     for(const row of d[t]||[]){const c=Object.keys(row);
      for(const k of c)if(!have.has(k)&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)){db.exec(`ALTER TABLE ${t} ADD COLUMN ${k}`);have.add(k)}
      db.prepare(`INSERT OR REPLACE INTO ${t}(${c.join(",")}) VALUES(${c.map(()=>"?").join(",")})`).run(...c.map(k=>row[k]))}}
    // safety copies of what was in the backup at startup: row 2 is kept from the very first start, row 3 is the previous start
    try{const o=await(await sb("GET","backup?id=eq.2&select=id")).json();if(!o.length)await sb("POST","backup?on_conflict=id",{id:2,data:d});await sb("POST","backup?on_conflict=id",{id:3,data:d})}catch(e){console.warn("Safety copy failed:",e.message)}
    console.log("Restored data from Supabase, kept",Object.keys(EXTRA).length,"extra table(s)")}
   else console.log("No backup yet, starting fresh");
   return;
  }catch(e){console.error("Restore attempt failed:",e.message);await new Promise(r=>setTimeout(r,3000))}
 }
 console.error("Could not read the Supabase backup. Stopping so an empty database never overwrites it.");process.exit(1);
}
let saveTimer=null,saving=false,again=false;
async function save(){
 if(!SB_ON)return;if(saving){again=true;return}
 saving=true;
 try{do{again=false;const r=await sb("POST","backup?on_conflict=id",{id:1,data:dump()});if(!r.ok)throw new Error(r.status+" "+await r.text())}while(again)}
 catch(e){console.error("Backup failed:",e.message);setTimeout(scheduleSave,10000)}
 finally{saving=false}
}
function scheduleSave(){if(!SB_ON||saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;save()},2000)}
const bye=async()=>{clearTimeout(saveTimer);saveTimer=null;await save();process.exit(0)};
process.on("SIGTERM",bye);process.on("SIGINT",bye);

(async()=>{
await restore();
q("DELETE FROM messages WHERE sys=1").run();
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,32).toString("hex");
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
class E extends Error{}
const bad=m=>{throw new E(m)};
const find=id=>q("SELECT * FROM players WHERE id=?").get(String(id||"").toLowerCase());

// banned words for usernames: ignores case, underscores and look-alike digits (b4dw0rd = badword)
const norm=s=>String(s).toLowerCase().replace(/[_\s]/g,"").replace(/0/g,"o").replace(/1/g,"i").replace(/3/g,"e").replace(/4/g,"a").replace(/5/g,"s").replace(/7/g,"t");
const hasBad=name=>{const n=norm(name);return q("SELECT w FROM badwords").all().some(r=>n.includes(norm(r.w)))};

// The admin account always uses ADMIN_PASSWORD; nobody else can register that name.
{const salt=crypto.randomBytes(16).toString("hex"),h=hashPw(ADMIN_PW,salt);
 if(find(ROOT))q("UPDATE players SET salt=?,hash=?,admin=1,banned=0 WHERE id=?").run(salt,h,ROOT);
 else q("INSERT INTO players(id,name,salt,hash,admin,infinite) VALUES(?,?,?,?,1,1)").run(ROOT,ROOT,salt,h);
 q("DELETE FROM sessions WHERE ts<?").run(Date.now()-30*864e5)}

const fails=new Map();
const blocked=k=>(fails.get(k)||[]).filter(t=>Date.now()-t<6e5).length>=8;
const strike=k=>fails.set(k,[...(fails.get(k)||[]).filter(t=>Date.now()-t<6e5),Date.now()]);
const lastMsg=new Map();

function login(b,ip){
 const name=String(b.name||"").trim(),pw=String(b.pw||""),id=name.toLowerCase();
 if(!/^[A-Za-z0-9_]{2,16}$/.test(name))bad("Use 2–16 letters, numbers or underscores.");
 if(pw.length<6)bad("Password must be at least 6 characters.");
 const key=ip+":"+id;if(blocked(key))bad("Too many tries. Wait a few minutes.");
 const p=find(id);
 if(p){
  if(!same(hashPw(pw,p.salt),p.hash)){strike(key);bad("Wrong username or password.")}
  if(p.banned)bad("This account is banned.");
 }else{
  if(id===ROOT)bad("That name is reserved.");
  if(hasBad(id))bad("That username isn’t allowed. Pick another one.");
  if(q("SELECT 1 FROM blocked WHERE id=?").get(id))bad("This account is banned.");
  const salt=crypto.randomBytes(16).toString("hex");
  q("INSERT INTO players(id,name,salt,hash) VALUES(?,?,?,?)").run(id,name,salt,hashPw(pw,salt));
 }
 const token=crypto.randomBytes(24).toString("hex");
 q("INSERT INTO sessions VALUES(?,?,?)").run(token,id,Date.now());
 return{token,id};
}
function auth(req,url){
 const t=(req.headers.authorization||"").replace(/^Bearer /,"")||url.searchParams.get("t")||"";
 const s=q("SELECT pid FROM sessions WHERE token=?").get(t);
 const p=s&&find(s.pid);
 return p&&!p.banned?p:null;
}

// ---- game logic: every rule is enforced here, not in the page
const clamp=(v,n)=>Math.max(0,Math.min(n-1,parseInt(v)||0));
const post=(name,text,sys=1)=>{if(sys)return;q("INSERT INTO messages(name,text,ts,sys) VALUES(?,?,?,?)").run(name,text,Date.now(),0)};
const adm=p=>{if(!p.admin)bad("Admins only")},root=p=>{if(p.id!==ROOT)bad("Only "+ROOT+" can do that")};
const inf=p=>p.id===ROOT&&!!p.infinite;
const ANIMS=["slash","fire","water","bolt","star","claw"],SCRATCH={id:0,name:"Scratch",damage:10,anim:"slash",type:"normal"};
const ivm=new Map(),iv=s=>{let h=ivm.get(s);if(!h){if(ivm.size>500)ivm.clear();h=crypto.createHash("md5").update(s).digest("hex").slice(0,8);ivm.set(s,h)}return h};
const imgOk=v=>typeof v==="string"&&v.length<80000&&/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(v)?v:"";
// custom attack animations: a GIF, or up to 12 small PNG frames
const normFx=v=>{if(v&&v.t==="gif"&&typeof v.g==="string"&&v.g.length<125000&&/^data:image\/gif;base64,[A-Za-z0-9+\/=]+$/.test(v.g))return JSON.stringify({t:"gif",g:v.g});
 if(v&&v.t==="frames"&&Array.isArray(v.f)){const f=v.f.slice(0,12);if(f.length&&f.every(x=>typeof x==="string"&&x.length<30000&&/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(x))&&f.join("").length<120000)return JSON.stringify({t:"frames",f,ms:Math.min(500,Math.max(50,parseInt(v.ms)||120))})}
 return""};
const fxInfo=m=>{if(!m||!m.fx)return null;try{const o=JSON.parse(m.fx);return o.t==="gif"?{t:"gif",url:`/img/move/${m.id}?v=${iv(m.fx)}`}:{t:"frames",ms:o.ms,urls:o.f.map((_,i)=>`/img/move/${m.id}/${i}?v=${iv(m.fx)}`)}}catch(e){return null}};
// abilities: owned list, and the equipped subset (eq NULL = everything owned counts as equipped)
const owned=p=>JSON.parse(p.moves||"[]");
const equipped=p=>{const o=owned(p);if(p.eq==null)return o;const e=JSON.parse(p.eq);return o.filter(id=>e.includes(id))};
// per-cat equips: {catId:[moveIds]}, 0 = Scratch. An ability sits on one cat at a time; Scratch can be on every cat.
// Players from before this existed get their old equips on their first cat.
const eqMap=p=>{let m=null;try{if(p.eqc!=null)m=JSON.parse(p.eqc)}catch(e){}
 const cs=JSON.parse(p.cats||"[]"),own=owned(p),old=equipped(p),out={},used=new Set();
 cs.forEach((c,i)=>{const src=m?(m[c]||[0]):[...(p.noscratch?[]:[0]),...(i===0?old:[])];
  out[c]=[...new Set(src)].filter(id=>{if(id===0)return true;if(!own.includes(id)||used.has(id))return false;used.add(id);return true})});
 return out};
// battle teams: every cat the player owns, lead cat first. cat/hp mirror the active cat.
const sync=s=>{const c=s.team[s.cur];s.cat={id:c.id,name:c.name,img:c.img,max:c.max,lvl:c.lvl,t:c.t};s.hp=c.hp;return s};
const mkTeam=(pl,lead)=>{const cs=JSON.parse(pl.cats||"[]").map(id=>q("SELECT * FROM cats WHERE id=?").get(id)).filter(Boolean).sort((a,b)=>(b.id===lead)-(a.id===lead));
 if(!cs.length)bad(pl.name+" has no cats");const cx0=JSON.parse(pl.cx||"{}");
 return sync({pid:pl.id,name:pl.name,team:cs.map((c,i)=>{const lv=lvOf(cx0[c.id]||0),mx=hpAt(c.hp,lv);return{id:c.id,name:c.name,img:c.img?`/img/cat/${c.id}?v=${iv(c.img)}`:"",max:mx,hp:mx,lvl:lv,t:[c.t1||"normal",c.t2||""].filter(Boolean),used:i===0}}),cur:0})};
// bets: both players' coins are held when the battle starts; the winner gets the pot
const finish=(x,win)=>{x.state="done";x.winner=win;x.n++;if(x.n>=4)awardXp(x,win);if(x.pot&&!x.paid){x.paid=1;q("UPDATE players SET coins=coins+? WHERE id=?").run(x.pot,win)}};
const refund=x=>{if(x.state==="active"&&x.bet&&!x.paid){x.paid=1;for(const s of[x.a,x.b]){const pl=find(s.pid);if(pl&&!inf(pl))q("UPDATE players SET coins=coins+? WHERE id=?").run(x.bet,pl.id)}}};
const battles=new Map();let bid=0;const trades=new Map();let tid=0;
const inBattle=id=>[...battles.values()].find(x=>x.a.pid===id||x.b.pid===id);
const ft=(pl,c)=>({pid:pl.id,name:pl.name,cat:{id:c.id,name:c.name,img:c.img?`/img/cat/${c.id}?v=${iv(c.img)}`:"",max:c.hp,t:[c.t1||"normal",c.t2||""].filter(Boolean)},hp:c.hp});
const wipe=id=>{q("DELETE FROM notes WHERE pid=?").run(id);q("DELETE FROM items WHERE seller=? AND stock!=0").run(id);q("DELETE FROM sessions WHERE pid=?").run(id);
 for(const[k,x]of battles)if(x.a.pid===id||x.b.pid===id){refund(x);battles.delete(k)}
 for(const[k,x]of trades)if(x.from===id||x.to===id)trades.delete(k);
 const re=new RegExp("(^|[^A-Za-z0-9_])"+id+"($|[^A-Za-z0-9_])","i");
 for(const m of q("SELECT id,name,text,sys FROM messages").all())if(String(m.name).toLowerCase()===id||(m.sys&&re.test(m.text)))q("DELETE FROM messages WHERE id=?").run(m.id);
 q("DELETE FROM players WHERE id=?").run(id)};
const normT=v=>{const it={};for(const[k,n]of Object.entries((v&&v.items)||{}).slice(0,10)){const id=parseInt(k),c=parseInt(n);if(id>0&&c>0)it[id]=Math.min(c,99)}
 return{items:it,cats:[...new Set(((v&&v.cats)||[]).map(x=>parseInt(x)).filter(x=>x>0))].slice(0,10)}};
const empty=t=>!Object.keys(t.items).length&&!t.cats.length;
const owns=(pl,t)=>{const inv=JSON.parse(pl.inv),own=JSON.parse(pl.cats||"[]");return Object.entries(t.items).every(([id,n])=>(inv[id]||0)>=n)&&t.cats.every(id=>own.includes(id))};
// ---- types, levels and evolutions
const TYPES=["normal","fire","water","electric","grass","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"];
const CHART={normal:{rock:.5,steel:.5,ghost:0},fire:{fire:.5,water:.5,grass:2,ice:2,bug:2,rock:.5,dragon:.5,steel:2},water:{fire:2,water:.5,grass:.5,ground:2,rock:2,dragon:.5},
 electric:{water:2,electric:.5,grass:.5,ground:0,flying:2,dragon:.5},grass:{fire:.5,water:2,grass:.5,poison:.5,ground:2,flying:.5,bug:.5,rock:2,dragon:.5,steel:.5},
 ice:{fire:.5,water:.5,grass:2,ice:.5,ground:2,flying:2,dragon:2,steel:.5},fighting:{normal:2,ice:2,poison:.5,flying:.5,psychic:.5,bug:.5,rock:2,ghost:0,dark:2,steel:2,fairy:.5},
 poison:{grass:2,poison:.5,ground:.5,rock:.5,ghost:.5,steel:0,fairy:2},ground:{fire:2,electric:2,grass:.5,poison:2,flying:0,bug:.5,rock:2,steel:2},
 flying:{electric:.5,grass:2,fighting:2,bug:2,rock:.5,steel:.5},psychic:{fighting:2,poison:2,psychic:.5,dark:0,steel:.5},
 bug:{fire:.5,grass:2,fighting:.5,poison:.5,flying:.5,psychic:2,ghost:.5,dark:2,steel:.5,fairy:.5},rock:{fire:2,ice:2,fighting:.5,ground:.5,flying:2,bug:2,steel:.5},
 ghost:{normal:0,psychic:2,ghost:2,dark:.5},dragon:{dragon:2,steel:.5,fairy:0},dark:{fighting:.5,psychic:2,ghost:2,dark:.5,fairy:.5},
 steel:{fire:.5,water:.5,electric:.5,ice:2,rock:2,steel:.5,fairy:2},fairy:{fire:.5,fighting:2,poison:.5,dragon:2,dark:2,steel:.5}};
const eff=(mt,ts)=>(ts||[]).reduce((m,t)=>m*((CHART[mt]||{})[t]??1),1);
const rr=v=>String(v||"").trim().toLowerCase().slice(0,20);
const tp=v=>TYPES.includes(v)?v:"normal",t2f=(v,t1)=>TYPES.includes(v)&&v!==t1?v:"";
const MAXLV=100,need=l=>25+15*l;
const prog=xp=>{let l=1;xp=Math.max(0,parseInt(xp)||0);while(l<MAXLV&&xp>=need(l)){xp-=need(l);l++}return{lvl:l,into:xp,need:l<MAXLV?need(l):0}};
const lvOf=xp=>prog(xp).lvl,hpAt=(b,l)=>Math.round(b*(1+0.08*(l-1))),dmgAt=(d,l)=>Math.round(d*(1+0.05*(l-1)));
const evoOf=c=>{try{const o=JSON.parse(c.evo||"null");return o&&Array.isArray(o.to)?o:null}catch(e){return null}};
// after a real battle every cat that fought earns XP (winners more)
const awardXp=(x,win)=>{x.gain={};for(const s of[x.a,x.b]){const o=s===x.a?x.b:x.a,pl=find(s.pid);if(!pl||!s.team)continue;
 const top=Math.max(1,...(o.team||[]).filter(c=>c.used).map(c=>c.lvl||1)),cxs=JSON.parse(pl.cx||"{}"),gain=(s.pid===win?30:10)+3*top;
 for(const c of s.team)if(c.used)cxs[c.id]=(cxs[c.id]||0)+gain;
 x.gain[s.pid]=gain;q("UPDATE players SET cx=? WHERE id=?").run(JSON.stringify(cxs),pl.id)}};
// makers: a shop item that is used up when the player creates their own attack or cat
const useMaker=(p,id,kind)=>{const i=q("SELECT * FROM items WHERE id=?").get(parseInt(id));
 if(!i||i.kind!==kind)bad("That isn’t the right maker");
 const inv=JSON.parse(p.inv);if(!inv[i.id])bad("You don’t have that");
 if(--inv[i.id]<=0)delete inv[i.id];
 q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(inv),p.id);return i};
// arcade: a game must be started on the server before it can pay out; payouts are capped per 24 hours
const arc=new Map(),arcDay=new Map(),ARC_CAP=1000;
const actions={
 send(p,b){const t=String(b.text||"").trim().slice(0,300);if(!t)bad("Empty message");
  if(Date.now()-(lastMsg.get(p.id)||0)<500)bad("Slow down");lastMsg.set(p.id,Date.now());post(p.name,t,0)},
 pay(p,b){const t=find(b.to),n=parseInt(b.amt);
  if(!t||t.banned||t.id===p.id)bad("Pick another player by name");if(!(n>0))bad("Enter an amount");
  if(!inf(p)){if(p.coins<n)bad("You don’t have that many coins");q("UPDATE players SET coins=coins-? WHERE id=?").run(n,p.id)}
  q("UPDATE players SET coins=coins+? WHERE id=?").run(n,t.id);post(p.name,`${p.name} sent ${n} coins to ${t.name}`)},
 daily(p){if(Date.now()-p.daily<864e5)bad("Daily bonus isn’t ready yet");q("UPDATE players SET coins=coins+50,daily=? WHERE id=?").run(Date.now(),p.id)},
 buy(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||i.hidden)bad("That item is gone");if(i.stock===0)bad("Sold out");if(i.seller&&i.seller===p.id)bad("You can’t buy your own item");if(!inf(p)&&p.coins<i.price)bad("Not enough coins");
  const inv=JSON.parse(p.inv);inv[i.id]=(inv[i.id]||0)+1;
  q("UPDATE players SET coins=coins-?,inv=? WHERE id=?").run(inf(p)?0:i.price,JSON.stringify(inv),p.id);
  const sl=i.seller?find(i.seller):null;if(sl)q("UPDATE players SET coins=coins+? WHERE id=?").run(Math.floor(i.price*(i.stock<0?0.05:0.5)),sl.id);
  if(i.stock>0)q("UPDATE items SET stock=stock-1 WHERE id=?").run(i.id);
  if(i.kind==="physical"&&sl)q("INSERT INTO notes(pid,text,ts) VALUES(?,?,?)").run(sl.id,`${p.name} bought your real item ${i.emoji} ${i.name}. Hand it over to them!`,Date.now());
  post(p.name,`${p.name} bought ${i.emoji} ${i.name}${i.kind==="physical"?" (a real one!)":""}${sl?` from ${sl.name}`:""}`)},
 "item/sell"(p,b){const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give your item a name");
  const price=parseInt(b.price);if(!(price>=1&&price<=1e6))bad("Price must be between 1 and 1,000,000");
  if(!p.admin&&q("SELECT COUNT(*) c FROM items WHERE seller=? AND stock!=0").get(p.id).c>=MAX_SELL)bad(`You can only have ${MAX_SELL} items for sale at once`);
  const qty=b.qty===""||b.qty===null?-1:Math.min(99,Math.max(1,parseInt(b.qty)||1)),fee=p.admin?0:Math.ceil(price*(qty<0?1:qty)*0.2);
  if(fee){if(p.coins<fee)bad(`Listing this costs ${fee} coins (20% of the price)`);q("UPDATE players SET coins=coins-? WHERE id=?").run(fee,p.id)}
  q("INSERT INTO items(name,emoji,descr,price,stock,kind,seller,img) VALUES(?,?,?,?,?,?,?,?)").run(name,String(b.emoji||"").trim().slice(0,4)||"🎁",String(b.desc||"").trim().slice(0,80),price,qty,["physical","fun"].includes(b.kind)?b.kind:"normal",p.id,imgOk(b.img))},
 "item/cancel"(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||i.seller!==p.id||i.stock===0)bad("You can’t cancel that");
  const sold=q("SELECT inv FROM players").all().some(r=>JSON.parse(r.inv||"{}")[i.id]>0);
  if(sold)q("UPDATE items SET stock=0 WHERE id=?").run(i.id);else q("DELETE FROM items WHERE id=?").run(i.id)},
 avatar(p,b){
  const a={mode:b.mode==="photo"?"photo":"cat",fur:clamp(b.fur,8),eyes:clamp(b.eyes,5),pat:clamp(b.pat,4),acc:clamp(b.acc,5)};
  let photo=p.photo,pv=p.pv;
  if(b.photo==="")photo="";
  else if(typeof b.photo==="string"&&b.photo.length<80000&&/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(b.photo)){photo=b.photo;pv++}
  if(!photo)a.mode="cat";
  q("UPDATE players SET avatar=?,photo=?,pv=? WHERE id=?").run(JSON.stringify(a),photo,pv,p.id)},
 sell(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||(i.kind||"normal")!=="normal")bad("That item can’t be sold");
  const inv=JSON.parse(p.inv);if(!inv[i.id])bad("You don’t have that");
  if(--inv[i.id]<=0)delete inv[i.id];
  const got=Math.floor(i.price*0.7);
  q("UPDATE players SET coins=coins+?,inv=? WHERE id=?").run(got,JSON.stringify(inv),p.id);
  if(i.stock>=0&&!i.seller)q("UPDATE items SET stock=stock+1 WHERE id=?").run(i.id);
  post(p.name,`${p.name} sold a ${i.emoji} ${i.name} for ${got} coins`)},
 discard(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i||i.kind!=="fun")bad("You can only get rid of fun items");
  const inv=JSON.parse(p.inv);if(!inv[i.id])bad("You don’t have that");
  if(--inv[i.id]<=0)delete inv[i.id];
  q("UPDATE players SET inv=? WHERE id=?").run(JSON.stringify(inv),p.id);post(p.name,`${p.name} got rid of a ${i.emoji} ${i.name}`)},
 "note/dismiss"(p,b){q("DELETE FROM notes WHERE id=? AND pid=?").run(parseInt(b.id),p.id)},
 infinite(p,b){root(p);q("UPDATE players SET infinite=? WHERE id=?").run(b.on?1:0,p.id)},
 "item/add"(p,b){adm(p);const pr=parseInt(b.price);if(!(pr>=0&&pr<=1e6))bad("Enter a price (0 for a free item)");const name=String(b.name||"").trim().slice(0,40);if(!name)bad("Give the item a name");
  const st=parseInt(b.stock);
  const kind=["physical","fun","attackmaker","catmaker"].includes(b.kind)?b.kind:"normal",cap=Math.min(1e6,Math.max(0,parseInt(b.cap)||0));
  if(kind.endsWith("maker")&&cap<1)bad("Set the max "+(kind==="attackmaker"?"damage":"HP")+" for this maker");
  q("INSERT INTO items(name,emoji,descr,price,stock,kind,img,cap,rarity) VALUES(?,?,?,?,?,?,?,?,?)").run(name,String(b.emoji||"").trim().slice(0,4)||"🎁",String(b.desc||"").trim().slice(0,80),pr,st>0?st:-1,kind,imgOk(b.img),kind.endsWith("maker")?cap:0,rr(b.rarity))},
 "cat/add"(p,b){adm(p);const n=String(b.name||"").trim().slice(0,30);if(!n)bad("Give the cat a name");
  const t1=tp(b.t1);q("INSERT INTO cats(name,img,hp,price,t1,t2,po,rarity) VALUES(?,?,?,?,?,?,?,?)").run(n,imgOk(b.img),Math.min(9999,Math.max(1,parseInt(b.hp)||50)),Math.max(0,parseInt(b.price)||0),t1,t2f(b.t2,t1),b.po?1:0,rr(b.rarity))},
 "cat/buy"(p,b){const c=q("SELECT * FROM cats WHERE id=?").get(parseInt(b.id));if(!c||c.hidden||c.po)bad("That cat is gone");
  const own=JSON.parse(p.cats||"[]");if(own.includes(c.id))bad("You already have that cat");
  if(!inf(p)&&p.coins<c.price)bad("Not enough coins");own.push(c.id);
  q("UPDATE players SET coins=coins-?,cats=? WHERE id=?").run(inf(p)?0:c.price,JSON.stringify(own),p.id)},
 "cat/remove"(p,b){adm(p);q("UPDATE cats SET hidden=1 WHERE id=?").run(parseInt(b.id))},
 "move/add"(p,b){adm(p);const n=String(b.name||"").trim().slice(0,30);if(!n)bad("Give the ability a name");
  const fx=b.fx?normFx(b.fx):"";if(b.fx&&!fx)bad("That animation is too big or invalid");
  q("INSERT INTO moves(name,damage,anim,price,fx,type,rarity) VALUES(?,?,?,?,?,?,?)").run(n,Math.min(1e6,Math.max(1,parseInt(b.damage)||10)),ANIMS.includes(b.anim)?b.anim:"slash",Math.max(0,parseInt(b.price)||0),fx,tp(b.type),rr(b.rarity))},
 "move/equip"(p,b){const id=parseInt(b.id)||0,cat=parseInt(b.cat),on=!!b.on,cs=JSON.parse(p.cats||"[]");
  if(!cs.includes(cat))bad("You don’t own that cat");if(id&&!owned(p).includes(id))bad("You don’t know that ability");
  const m=eqMap(p);
  if(on){if(id)for(const c of cs)if(c!==cat&&m[c].includes(id)){const r=q("SELECT name FROM cats WHERE id=?").get(c);bad(`That ability is already equipped on ${r?r.name:"another cat"}. Take it off there first`)}
   if(!m[cat].includes(id))m[cat].push(id)}
  else m[cat]=m[cat].filter(v=>v!==id);
  if(!m[cat].length)bad("Keep at least one attack equipped on each cat");
  q("UPDATE players SET eqc=? WHERE id=?").run(JSON.stringify(m),p.id)},
 "move/remove"(p,b){adm(p);q("UPDATE moves SET hidden=1 WHERE id=?").run(parseInt(b.id))},
 "move/buy"(p,b){const m=q("SELECT * FROM moves WHERE id=?").get(parseInt(b.id));if(!m||m.hidden||m.owner)bad("That ability is gone");
  const own=JSON.parse(p.moves||"[]");if(own.includes(m.id))bad("You already know that ability");
  if(!inf(p)&&p.coins<m.price)bad("Not enough coins");own.push(m.id);
  q("UPDATE players SET coins=coins-?,moves=?,eq=? WHERE id=?").run(inf(p)?0:m.price,JSON.stringify(own),p.eq==null?null:JSON.stringify([...JSON.parse(p.eq),m.id]),p.id);post(p.name,`${p.name} learned ${m.name}`)},
 "battle/challenge"(p,b){const t=find(b.to),c=q("SELECT * FROM cats WHERE id=?").get(parseInt(b.cat));
  if(!t||t.banned||t.id===p.id)bad("Pick another player");if(!c)bad("Pick your cat");
  if(!JSON.parse(p.cats||"[]").includes(c.id))bad("You don’t own that cat");
  if(inBattle(p.id)||inBattle(t.id))bad("One of you is already in a battle");
  const bet=Math.max(0,Math.min(1e6,parseInt(b.bet)||0));if(!inf(p)&&p.coins<bet)bad("You don’t have enough coins for that bet");
  battles.set(++bid,{id:bid,state:"pending",bet,pot:0,need:null,a:ft(p,c),b:{pid:t.id,name:t.name,cat:null,hp:0},turn:"a",n:0,last:null,log:[],ts:Date.now()});
  post(p.name,`${p.name} challenged ${t.name} to a cat battle${bet?` for ${bet} coins`:""}`)},
 "battle/accept"(p,b){const x=battles.get(parseInt(b.id)),c=q("SELECT * FROM cats WHERE id=?").get(parseInt(b.cat));
  if(!x||x.state!=="pending"||x.b.pid!==p.id)bad("No challenge to accept");if(!c)bad("Pick your cat");
  if(!JSON.parse(p.cats||"[]").includes(c.id))bad("You don’t own that cat");
  const a=find(x.a.pid);if(!a||a.banned)bad("That challenge is gone");
  const ta=mkTeam(a,x.a.cat.id),tb=mkTeam(p,c.id);
  if(x.bet){if(!inf(p)&&p.coins<x.bet)bad(`You need ${x.bet} coins to accept this bet`);if(!inf(a)&&a.coins<x.bet)bad(`${a.name} can’t cover the bet anymore`);
   for(const pl of[a,p])if(!inf(pl))q("UPDATE players SET coins=coins-? WHERE id=?").run(x.bet,pl.id);x.pot=x.bet*2}
  x.a=ta;x.b=tb;x.state="active";x.ts=Date.now()},
 "battle/move"(p,b){const x=battles.get(parseInt(b.id));if(!x||x.state!=="active")bad("No active battle");
  if(x.need)bad("A cat has to be swapped in first");
  const me=x[x.turn];if(me.pid!==p.id)bad("It’s not your turn");
  const id=parseInt(b.move)||0,m=id?q("SELECT * FROM moves WHERE id=?").get(id):SCRATCH;
  if(!m||!(eqMap(p)[me.team[me.cur].id]||[]).includes(id))bad("That ability isn’t equipped on this cat");
  const os=x.turn==="a"?"b":"a",o=x[os],oc=o.team[o.cur],at=me.team[me.cur],mt=m.type||"normal",ef=eff(mt,oc.t),dmg=ef===0?0:Math.max(1,Math.round(dmgAt(m.damage,at.lvl||1)*ef*((at.t||[]).includes(mt)?1.5:1)));oc.hp=Math.max(0,oc.hp-dmg);sync(o);x.n++;x.ts=Date.now();
  x.last={by:me.pid,move:m.name,anim:m.anim,dmg,type:mt,fx:fxInfo(m)};x.log=[...x.log,`${me.cat.name} used ${m.name}! (${dmg} damage)${ef===0?" It had no effect…":ef>1?" Super effective!":ef<1?" Not very effective…":""}`].slice(-6);
  if(oc.hp<=0){x.log=[...x.log,`${o.name}’s ${oc.name} fainted!`].slice(-6);
   if(o.team.filter(c=>c.hp<=0).length>=Math.min(3,o.team.length)){finish(x,me.pid);post(p.name,`${me.name} beat ${o.name} in a cat battle`)}
   else{x.turn=os;x.need=os}}
  else x.turn=os},
 "battle/switch"(p,b){const x=battles.get(parseInt(b.id));if(!x||x.state!=="active")bad("No active battle");
  const side=x.a.pid===p.id?"a":x.b.pid===p.id?"b":"";if(!side)bad("That’s not your battle");
  const s=x[side],i=s.team.findIndex(c=>c.id===parseInt(b.cat));
  if(i<0||s.team[i].hp<=0||i===s.cur)bad("Pick a cat that can still fight");
  const free=x.need===side;if(!free&&(x.need||x.turn!==side))bad("It’s not your turn");
  s.cur=i;s.team[i].used=true;sync(s);x.n++;x.ts=Date.now();x.last=null;x.log=[...x.log,`${s.name} sent out ${s.cat.name}!`].slice(-6);
  if(free)x.need=null;else x.turn=side==="a"?"b":"a"},
 "battle/leave"(p){const x=inBattle(p.id);if(!x)bad("You’re not in a battle");
  if(x.state==="active"){x.log=[...x.log,`${p.name} gave up`].slice(-6);finish(x,x.a.pid===p.id?x.b.pid:x.a.pid)}else battles.delete(x.id)},
 "trade/offer"(p,b){const t=find(b.to);if(!t||t.banned||t.id===p.id)bad("Pick another player");
  const give=normT(b.give),want=normT(b.want);if(empty(give)&&empty(want))bad("Pick something to trade");
  if(!owns(p,give))bad("You don’t have everything you’re offering");if(!owns(t,want))bad(`${t.name} doesn’t have everything you asked for`);
  if(give.cats.some(id=>JSON.parse(t.cats||"[]").includes(id))||want.cats.some(id=>JSON.parse(p.cats||"[]").includes(id)))bad("You can only own one of each cat");
  if([...trades.values()].filter(x=>x.from===p.id).length>=3)bad("You already have 3 open offers");
  trades.set(++tid,{id:tid,from:p.id,to:t.id,give,want,ts:Date.now()})},
 "trade/accept"(p,b){const x=trades.get(parseInt(b.id));if(!x||x.to!==p.id)bad("That offer is gone");
  const a=find(x.from);if(!a||a.banned){trades.delete(x.id);bad("That offer is gone")}
  if(!owns(a,x.give)||!owns(p,x.want))bad("The trade can’t happen anymore, someone no longer has everything");
  const ia=JSON.parse(a.inv),ib=JSON.parse(p.inv),ca=JSON.parse(a.cats||"[]"),cb=JSON.parse(p.cats||"[]");
  if(x.give.cats.some(id=>cb.includes(id))||x.want.cats.some(id=>ca.includes(id)))bad("You can only own one of each cat");
  const mv=(f,g,t)=>{for(const[id,n]of Object.entries(t)){f[id]-=n;if(f[id]<=0)delete f[id];g[id]=(g[id]||0)+n}};
  mv(ia,ib,x.give.items);mv(ib,ia,x.want.items);
  const na=ca.filter(id=>!x.give.cats.includes(id)).concat(x.want.cats),nb=cb.filter(id=>!x.want.cats.includes(id)).concat(x.give.cats);
  const xa=JSON.parse(a.cx||"{}"),xb=JSON.parse(p.cx||"{}");for(const id of x.give.cats){xb[id]=xa[id]||0;delete xa[id]}for(const id of x.want.cats){xa[id]=xb[id]||0;delete xb[id]}
  q("UPDATE players SET inv=?,cats=?,cx=? WHERE id=?").run(JSON.stringify(ia),JSON.stringify(na),JSON.stringify(xa),a.id);
  q("UPDATE players SET inv=?,cats=?,cx=? WHERE id=?").run(JSON.stringify(ib),JSON.stringify(nb),JSON.stringify(xb),p.id);trades.delete(x.id)},
 "trade/cancel"(p,b){const x=trades.get(parseInt(b.id));if(!x||(x.from!==p.id&&x.to!==p.id))bad("That offer is gone");trades.delete(x.id)},
 "maker/attack"(p,b){const i=useMaker(p,b.id,"attackmaker");
  const n=String(b.name||"").trim().slice(0,30);if(!n)bad("Give your attack a name");
  const dmg=parseInt(b.damage);if(!(dmg>=1))bad("Enter the damage");if(dmg>i.cap)bad(`This maker allows up to ${i.cap} damage`);
  const fx=b.fx?normFx(b.fx):"";if(b.fx&&!fx)bad("That animation is too big or invalid");
  const id=Number(q("INSERT INTO moves(name,damage,anim,price,fx,owner,type) VALUES(?,?,?,?,?,?,?)").run(n,dmg,ANIMS.includes(b.anim)?b.anim:"slash",0,fx,p.id,tp(b.type)).lastInsertRowid);
  const own=owned(p);own.push(id);
  q("UPDATE players SET moves=?,eq=? WHERE id=?").run(JSON.stringify(own),p.eq==null?null:JSON.stringify([...JSON.parse(p.eq),id]),p.id)},
 "maker/cat"(p,b){const i=useMaker(p,b.id,"catmaker");
  const n=String(b.name||"").trim().slice(0,30);if(!n)bad("Give your cat a name");
  const hp=parseInt(b.hp);if(!(hp>=1))bad("Enter the HP");if(hp>i.cap)bad(`This maker allows up to ${i.cap} HP`);
  const id=Number(q("INSERT INTO cats(name,img,hp,price,owner,t1,t2) VALUES(?,?,?,?,?,?,?)").run(n,imgOk(b.img),hp,0,p.id,tp(b.t1),t2f(b.t2,tp(b.t1))).lastInsertRowid);
  const own=JSON.parse(p.cats||"[]");own.push(id);
  q("UPDATE players SET cats=? WHERE id=?").run(JSON.stringify(own),p.id)},
 "cat/evo"(p,b){adm(p);const c=q("SELECT * FROM cats WHERE id=?").get(parseInt(b.id));if(!c)bad("That cat is gone");
  if(b.clear){q("UPDATE cats SET evo='' WHERE id=?").run(c.id);return}
  const lvl=parseInt(b.lvl);if(!(lvl>=2&&lvl<=MAXLV))bad(`Pick a level from 2 to ${MAXLV}`);
  const to=[...new Set((Array.isArray(b.to)?b.to:[]).map(x=>parseInt(x)))].filter(id=>q("SELECT 1 FROM cats WHERE id=?").get(id));
  if(!to.length)bad("Pick at least one cat to evolve into");if(to.length>10)bad("At most 10 choices");if(to.includes(c.id))bad("A cat can’t evolve into itself");
  q("UPDATE cats SET evo=? WHERE id=?").run(JSON.stringify({lvl,to}),c.id);
  // no loops, and no more than 10 evolutions in a row
  const depth=(id,seen)=>{if(seen.includes(id))return Infinity;const r=q("SELECT evo FROM cats WHERE id=?").get(id),o=r&&evoOf(r);return o?1+Math.max(0,...o.to.map(t=>depth(t,[...seen,id]))):0};
  const worst=Math.max(...q("SELECT id FROM cats").all().map(r=>depth(r.id,[])));
  if(worst===Infinity)bad("That would make a loop of evolutions");if(worst>10)bad("A cat can evolve at most 10 times in a row")},
 "cat/evolve"(p,b){const c=q("SELECT * FROM cats WHERE id=?").get(parseInt(b.id));if(!c)bad("That cat is gone");
  const own=JSON.parse(p.cats||"[]");if(!own.includes(c.id))bad("You don’t own that cat");{const bt=inBattle(p.id);if(bt&&bt.state==="active")bad("Finish your battle first")}
  const ev=evoOf(c);if(!ev)bad("That cat can’t evolve");
  const cxs=JSON.parse(p.cx||"{}");if(lvOf(cxs[c.id]||0)<ev.lvl)bad(`${c.name} needs to reach level ${ev.lvl}`);
  const tid=ev.to.length===1?ev.to[0]:parseInt(b.to);if(!ev.to.includes(tid))bad("Pick what to evolve into");
  const t=q("SELECT * FROM cats WHERE id=?").get(tid);if(!t)bad("That form is gone");if(own.includes(t.id))bad(`You already have ${t.name}`);
  const em=eqMap(p);em[t.id]=em[c.id]||[0];delete em[c.id];
  own[own.indexOf(c.id)]=t.id;cxs[t.id]=cxs[c.id]||0;delete cxs[c.id];
  q("UPDATE players SET cats=?,cx=?,eqc=? WHERE id=?").run(JSON.stringify(own),JSON.stringify(cxs),JSON.stringify(em),p.id);post(p.name,`${c.name} evolved into ${t.name}`)},
 "item/remove"(p,b){adm(p);const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));if(!i)bad("That item is gone");
  q("UPDATE items SET hidden=1"+(i.seller?",stock=0":"")+" WHERE id=?").run(i.id)},
 "shop/restore"(p,b){adm(p);const t={item:"items",cat:"cats",move:"moves"}[b.kind];if(!t)bad("Unknown kind");q(`UPDATE ${t} SET hidden=0 WHERE id=?`).run(parseInt(b.id))},
 "shop/delete"(p,b){adm(p);const t={item:"items",cat:"cats",move:"moves"}[b.kind];if(!t)bad("Unknown kind");q(`UPDATE ${t} SET hidden=2 WHERE id=? AND hidden=1`).run(parseInt(b.id))},
 "admin/promote"(p,b){adm(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t change that player");
  q("UPDATE players SET admin=? WHERE id=?").run(t.admin?0:1,t.id);post(p.name,`${t.name} ${t.admin?"is no longer":"is now"} an admin`)},
 "admin/give"(p,b){root(p);const t=find(b.to),n=parseInt(b.n);if(!t||!n)bad("Pick a player and an amount");
  q("UPDATE players SET coins=MAX(0,coins+?) WHERE id=?").run(n,t.id);post(p.name,`${p.name} ${n>0?"gave":"took"} ${Math.abs(n)} coins ${n>0?"to":"from"} ${t.name}`)},
 "admin/ban"(p,b){root(p);const t=find(b.to);if(!t||t.id===ROOT)bad("You can’t ban that player");
  q("INSERT OR IGNORE INTO blocked(id) VALUES(?)").run(t.id);wipe(t.id);return{kick:t.id,reason:"banned"}},
 "admin/unban"(p,b){root(p);const id=String(b.to||"").toLowerCase();q("DELETE FROM blocked WHERE id=?").run(id);post(p.name,`${id} can sign up again`)},
 deleteMe(p,b){if(p.id===ROOT)bad("The admin account can’t be deleted");
  if(!same(hashPw(String(b.pw||""),p.salt),p.hash))bad("Wrong password");
  wipe(p.id);post("CatChat",`${p.name} deleted their account`);return{kick:p.id,reason:"deleted"}},
 "admin/delmsg"(p,b){adm(p);q("DELETE FROM messages WHERE id=?").run(parseInt(b.id))},
 "word/ban"(p,b){adm(p);const w=String(b.w||"").trim().toLowerCase().slice(0,16);if(!/^[a-z0-9_]+$/.test(w)||norm(w).length<3)bad("Use a word of 3+ letters or numbers");
  q("INSERT OR IGNORE INTO badwords(w) VALUES(?)").run(w)},
 "word/unban"(p,b){adm(p);q("DELETE FROM badwords WHERE w=?").run(String(b.w||"").toLowerCase())},
 "news/add"(p,b){adm(p);const t=String(b.title||"").trim().slice(0,80),x=String(b.body||"").trim().slice(0,1000);if(!t||!x)bad("Write a headline and some text");q("INSERT INTO news(title,body,name,ts) VALUES(?,?,?,?)").run(t,x,p.name,Date.now())},
 "news/remove"(p,b){adm(p);q("DELETE FROM news WHERE id=?").run(parseInt(b.id))},
 "arcade/start"(p,b){if(!["chess","tetris","snake"].includes(b.game))bad("Unknown game");arc.set(p.id,{game:b.game,ts:Date.now()})},
 "arcade/finish"(p,b){const s=arc.get(p.id);arc.delete(p.id);if(!s||s.game!==b.game||Date.now()-s.ts>72e5)bad("That game wasn’t started");
  const sec=(Date.now()-s.ts)/1000;let pts=0,reward=0;
  if(s.game==="chess"){if(b.win===true&&sec>=60&&(parseInt(b.moves)||0)>=6)reward=100}
  else{pts=Math.max(0,parseInt(b.score)||0);const max=s.game==="snake"?Math.floor(sec*30)+10:Math.floor(sec*200)+300;if(pts>max)bad("That score doesn’t look right");reward=Math.floor(pts/2)}
  const now=Date.now(),d=arcDay.get(p.id),cur=d&&now-d.ts<864e5?d:{ts:now,n:0},give=Math.max(0,Math.min(reward,ARC_CAP-cur.n));
  cur.n+=give;arcDay.set(p.id,cur);if(give)q("UPDATE players SET coins=coins+? WHERE id=?").run(give,p.id);
  return{res:{game:s.game,pts,reward:give,capped:give<reward}}},
 "admin/clear"(p){adm(p);q("DELETE FROM messages").run()},
};
function tx(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r}catch(e){db.exec("ROLLBACK");throw e}}

// ---- live updates (Server-Sent Events)
const clients=new Set();
const pub=p=>{const a=JSON.parse(p.avatar||"{}");
 return{id:p.id,name:p.name,coins:p.coins,inv:JSON.parse(p.inv||"{}"),cats:JSON.parse(p.cats||"[]"),admin:!!p.admin,banned:!!p.banned,inf:p.id===ROOT&&!!p.infinite,avatar:Object.keys(a).length?{...a,photo:p.photo?`/avatar/${p.id}?v=${p.pv}-${iv(p.photo)}`:""}:undefined}};
const snapshot=()=>{const on=new Set([...clients].map(c=>c.pid));return JSON.stringify({
 players:q("SELECT * FROM players").all().map(p=>({...pub(p),online:on.has(p.id)})),
 items:q("SELECT * FROM items").all().map(i=>({id:i.id,name:i.name,emoji:i.emoji,desc:i.descr,price:i.price,stock:i.stock,kind:i.kind||"normal",seller:i.seller||"",cap:i.cap||0,rarity:i.rarity||"",listed:!i.hidden,gone:i.hidden===2,img:i.img?`/img/item/${i.id}?v=${iv(i.img)}`:""})),
 cats:q("SELECT * FROM cats").all().map(c=>({id:c.id,name:c.name,hp:c.hp,price:c.price||0,owner:c.owner||"",rarity:c.rarity||"",po:!!c.po,t:[c.t1||"normal",c.t2||""].filter(Boolean),evo:evoOf(c),listed:!c.hidden,gone:c.hidden===2,img:c.img?`/img/cat/${c.id}?v=${iv(c.img)}`:""})),
 moves:q("SELECT * FROM moves").all().map(k=>({id:k.id,name:k.name,damage:k.damage,anim:k.anim,price:k.price,owner:k.owner||"",rarity:k.rarity||"",type:k.type||"normal",listed:!k.hidden,gone:k.hidden===2,fx:fxInfo(k)})),
 messages:q("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 80) ORDER BY id").all(),
 news:q("SELECT * FROM news ORDER BY id DESC LIMIT 30").all()})};
function sendTo(c,base){const m=find(c.pid);if(!m)return;const cxm=JSON.parse(m.cx||"{}");
 c.res.write("event: state\ndata: "+base.slice(0,-1)+',"me":'+JSON.stringify({inv:JSON.parse(m.inv),daily:m.daily,moves:JSON.parse(m.moves||"[]"),eq:equipped(m),scratch:!m.noscratch,lv:Object.fromEntries(JSON.parse(m.cats||"[]").map(id=>{const c=q("SELECT hp FROM cats WHERE id=?").get(id),pg=prog(cxm[id]||0);return[id,{...pg,hp:c?hpAt(c.hp,pg.lvl):0}]})),eqc:eqMap(m),battle:inBattle(m.id)||null,trades:[...trades.values()].filter(x=>x.from===m.id||x.to===m.id).map(({id,from,to,give,want})=>({id,from,to,give,want})),blocked:m.id===ROOT?q("SELECT id FROM blocked").all().map(r=>r.id):undefined,notes:q("SELECT id,text FROM notes WHERE pid=? ORDER BY id").all(m.id),words:m.admin?q("SELECT w FROM badwords ORDER BY w").all().map(r=>r.w):undefined})+"}\n\n")}
function broadcast(){if(!clients.size)return;const base=snapshot();for(const c of clients)sendTo(c,base)}
function push(){scheduleSave();broadcast()}
setInterval(()=>{for(const c of clients)c.res.write(": ping\n\n")},25000);
setInterval(()=>{let d=0;for(const[k,x]of trades)if(Date.now()-x.ts>18e5){trades.delete(k);d=1}for(const[k,x]of battles)if(Date.now()-x.ts>9e5){refund(x);battles.delete(k);d=1}if(d)push()},60000);

// ---- http
const INDEX=fs.readFileSync(path.join(__dirname,"index.html"));
const CSP="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const J=(res,code,o)=>{res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(o))};
const readBody=(req,lim=200e3)=>new Promise((ok,no)=>{let n=0;const c=[];
 req.on("data",d=>{n+=d.length;if(n>lim){no(new E("That’s too large"));req.destroy()}else c.push(d)});
 req.on("end",()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||"{}"))}catch(e){no(new E("Bad request"))}});
 req.on("error",no)});

http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://x");
 try{
  if(req.method==="GET"){
   if(url.pathname==="/"||url.pathname==="/index.html"){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":CSP,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});return res.end(INDEX)}
   if(url.pathname==="/healthz")return res.end("ok");
   if(url.pathname==="/api/me"){const p=auth(req,url);return p?J(res,200,{id:p.id}):J(res,401,{error:"auth"})}
   if(url.pathname==="/events"){const p=auth(req,url);if(!p)return J(res,401,{error:"auth"});
    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","X-Accel-Buffering":"no"});
    res.write("retry: 3000\n\n");const c={res,pid:p.id};clients.add(c);req.on("close",()=>{clients.delete(c);broadcast()});return broadcast()}
   if(url.pathname.startsWith("/img/move/")){const[,,,id,n]=url.pathname.split("/"),r=q("SELECT fx FROM moves WHERE id=?").get(parseInt(id));let o={};try{o=JSON.parse(r&&r.fx||"{}")}catch(e){}
    const s=o.t==="gif"?o.g:o.t==="frames"?o.f[parseInt(n)]:"",m=/^data:(image\/(?:gif|png));base64,(.*)$/.exec(s||"");if(!m)return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":m[1],"Cache-Control":"public,max-age=31536000,immutable","X-Content-Type-Options":"nosniff"});return res.end(Buffer.from(m[2],"base64"))}
   if(url.pathname.startsWith("/img/")){const[,,k,id]=url.pathname.split("/"),r=(k==="item"||k==="cat")&&q(`SELECT img FROM ${k==="cat"?"cats":"items"} WHERE id=?`).get(parseInt(id)),
     m=r&&/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(r.img||"");if(!m)return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":m[1],"Cache-Control":"public,max-age=31536000,immutable","X-Content-Type-Options":"nosniff"});return res.end(Buffer.from(m[2],"base64"))}
   if(url.pathname.startsWith("/avatar/")){const p=find(url.pathname.slice(8));
    if(!p||!p.photo)return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"public,max-age=31536000,immutable","X-Content-Type-Options":"nosniff"});
    return res.end(Buffer.from(p.photo.split(",")[1],"base64"))}
  }
  if(req.method==="POST"&&url.pathname.startsWith("/api/")){
   const act=url.pathname.slice(5),b=await readBody(req);
   if(act==="login"){const ip=req.headers["fly-client-ip"]||req.socket.remoteAddress;const r=login(b,ip);push();return J(res,200,r)}
   const p=auth(req,url);if(!p)return J(res,401,{error:"auth"});
   if(act==="logout"){q("DELETE FROM sessions WHERE token=?").run((req.headers.authorization||"").replace(/^Bearer /,""));scheduleSave();return J(res,200,{ok:1})}
   if(!Object.hasOwn(actions,act))return J(res,404,{error:"Unknown action"});
   const r=tx(()=>actions[act](p,b));push();
   if(r&&r.kick)for(const c of clients)if(c.pid===r.kick){c.res.write("event: bye\ndata: "+(r.reason||"")+"\n\n");c.res.end();clients.delete(c)}
   return J(res,200,r&&r.res?{ok:1,res:r.res}:{ok:1});
  }
  res.writeHead(404).end("Not found");
 }catch(e){
  if(e instanceof E)return J(res,400,{error:e.message});
  console.error(e);J(res,500,{error:"Server error"});
 }
}).listen(PORT,"0.0.0.0",()=>console.log("CatChat listening on "+PORT));
scheduleSave();
})().catch(e=>{console.error(e);process.exit(1)});
