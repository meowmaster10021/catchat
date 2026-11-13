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
try{db.exec("ALTER TABLE players ADD COLUMN ceq TEXT DEFAULT '{}'")}catch(e){}
try{db.exec("ALTER TABLE cats ADD COLUMN listed INTEGER DEFAULT 1")}catch(e){}
db.exec("CREATE TABLE IF NOT EXISTS badwords(w TEXT PRIMARY KEY)");
db.exec("CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,pid TEXT,text TEXT,ts INTEGER)");
const MAX_SELL=5,MAX_DMG=1e6,MAX_HP=MAX_DMG*10;
const q=s=>db.prepare(s);

// ---- persistence: the host's disk is wiped when the server sleeps, so the whole
// database is copied to Supabase (one row) after changes and loaded back on startup.
const SB_URL=(process.env.SUPABASE_URL||"").replace(/\/+$/,""),SB_KEY=process.env.SUPABASE_SERVICE_KEY||"",SB_ON=!!(SB_URL&&SB_KEY);
const TABLES=["players","items","messages","sessions","blocked","cats","moves","notes","badwords"];
const sb=(method,p,body)=>fetch(SB_URL+"/rest/v1/"+p,{method,headers:{apikey:SB_KEY,...(SB_KEY.startsWith("eyJ")?{Authorization:"Bearer "+SB_KEY}:{}),"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},body:body&&JSON.stringify(body)});
const dump=()=>{const o={};for(const t of TABLES)o[t]=db.prepare("SELECT * FROM "+t).all();return o};
async function restore(){
 if(!SB_ON){console.warn("WARNING: SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Data will be lost when the server sleeps.");return}
 for(let i=0;i<5;i++){
  try{
   const r=await sb("GET","backup?id=eq.1&select=data");
   if(!r.ok)throw new Error(r.status+" "+await r.text());
   const rows=await r.json();
   if(rows.length){const d=rows[0].data||{};
    for(const t of TABLES)for(const row of d[t]||[]){const c=Object.keys(row);
     db.prepare(`INSERT OR REPLACE INTO ${t}(${c.join(",")}) VALUES(${c.map(()=>"?").join(",")})`).run(...c.map(k=>row[k]))}
    console.log("Restored data from Supabase")}
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
// keep cat ids from being reused: bump the id counter past every id anyone owns, and drop owned ids that no longer exist
{const ids=new Set(q("SELECT id FROM cats").all().map(r=>r.id));let mx=Math.max(0,...ids);
 for(const pl of q("SELECT id,cats FROM players").all()){const own=JSON.parse(pl.cats||"[]");own.forEach(i=>mx=Math.max(mx,i));
  const keep=own.filter(i=>ids.has(i));if(keep.length!==own.length)q("UPDATE players SET cats=? WHERE id=?").run(JSON.stringify(keep),pl.id)}
 const r=q("SELECT seq FROM sqlite_sequence WHERE name='cats'").get();
 if(r){if(r.seq<mx)q("UPDATE sqlite_sequence SET seq=? WHERE name='cats'").run(mx)}else q("INSERT INTO sqlite_sequence(name,seq) VALUES('cats',?)").run(mx)}
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
const ANIMS=["slash","fire","water","bolt","star","claw"],SCRATCH={id:0,name:"Scratch",damage:10,anim:"slash"};
const imgOk=v=>typeof v==="string"&&v.length<80000&&/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(v)?v:"";
// custom attack animations: a GIF, or up to 12 small PNG frames
const normFx=v=>{if(v&&v.t==="gif"&&typeof v.g==="string"&&v.g.length<125000&&/^data:image\/gif;base64,[A-Za-z0-9+\/=]+$/.test(v.g))return JSON.stringify({t:"gif",g:v.g});
 if(v&&v.t==="frames"&&Array.isArray(v.f)){const f=v.f.slice(0,12);if(f.length&&f.every(x=>typeof x==="string"&&x.length<30000&&/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(x))&&f.join("").length<120000)return JSON.stringify({t:"frames",f,ms:Math.min(500,Math.max(50,parseInt(v.ms)||120))})}
 return""};
const fxInfo=m=>{if(!m||!m.fx)return null;try{const o=JSON.parse(m.fx);return o.t==="gif"?{t:"gif",url:`/img/move/${m.id}`}:{t:"frames",ms:o.ms,urls:o.f.map((_,i)=>`/img/move/${m.id}/${i}`)}}catch(e){return null}};
// abilities: owned list, and the equipped subset (eq NULL = everything owned counts as equipped)
const owned=p=>JSON.parse(p.moves||"[]");
const equipped=p=>{const o=owned(p);if(p.eq==null)return o;const e=JSON.parse(p.eq);return o.filter(id=>e.includes(id))};
// per-cat equipment: ceq maps cat id -> equipped ability ids. A cat with no choice yet falls back to the old player-wide list.
const ceqOf=p=>{try{return JSON.parse(p.ceq||"{}")}catch(e){return{}}};
const equippedFor=(p,cid)=>{const m=ceqOf(p)[cid];if(!Array.isArray(m))return equipped(p);return owned(p).filter(id=>m.includes(id))};
// battle teams: every cat the player owns, lead cat first. cat/hp mirror the active cat.
const sync=s=>{const c=s.team[s.cur];s.cat={id:c.id,name:c.name,img:c.img,max:c.max};s.hp=c.hp;return s};
const mkTeam=(pl,lead)=>{const cs=JSON.parse(pl.cats||"[]").map(id=>q("SELECT * FROM cats WHERE id=?").get(id)).filter(Boolean).sort((a,b)=>(b.id===lead)-(a.id===lead));
 if(!cs.length)bad(pl.name+" has no cats");
 return sync({pid:pl.id,name:pl.name,team:cs.map(c=>({id:c.id,name:c.name,img:c.img?`/img/cat/${c.id}`:"",max:c.hp,hp:c.hp})),cur:0})};
// bets: both players' coins are held when the battle starts; the winner gets the pot
const finish=(x,win)=>{x.state="done";x.winner=win;x.n++;if(x.pot&&!x.paid){x.paid=1;q("UPDATE players SET coins=coins+? WHERE id=?").run(x.pot,win)}};
const refund=x=>{if(x.state==="active"&&x.bet&&!x.paid){x.paid=1;for(const s of[x.a,x.b]){const pl=find(s.pid);if(pl&&!inf(pl))q("UPDATE players SET coins=coins+? WHERE id=?").run(x.bet,pl.id)}}};
const battles=new Map();let bid=0;const trades=new Map();let tid=0;
const inBattle=id=>[...battles.values()].find(x=>x.a.pid===id||x.b.pid===id);
const ft=(pl,c)=>({pid:pl.id,name:pl.name,cat:{id:c.id,name:c.name,img:c.img?`/img/cat/${c.id}`:"",max:c.hp},hp:c.hp});
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
const actions={
 send(p,b){const t=String(b.text||"").trim().slice(0,300);if(!t)bad("Empty message");
  if(Date.now()-(lastMsg.get(p.id)||0)<500)bad("Slow down");lastMsg.set(p.id,Date.now());post(p.name,t,0)},
 pay(p,b){const t=find(b.to),n=parseInt(b.amt);
  if(!t||t.banned||t.id===p.id)bad("Pick another player by name");if(!(n>0))bad("Enter an amount");
  if(!inf(p)){if(p.coins<n)bad("You don’t have that many coins");q("UPDATE players SET coins=coins-? WHERE id=?").run(n,p.id)}
  q("UPDATE players SET coins=coins+? WHERE id=?").run(n,t.id);post(p.name,`${p.name} sent ${n} coins to ${t.name}`)},
 daily(p){if(Date.now()-p.daily<864e5)bad("Daily bonus isn’t ready yet");q("UPDATE players SET coins=coins+50,daily=? WHERE id=?").run(Date.now(),p.id)},
 buy(p,b){const i=q("SELECT * FROM items WHERE id=?").get(parseInt(b.id));
  if(!i)bad("That item is gone");if(i.stock===0)bad("Sold out");if(i.seller&&i.seller===p.id)bad("You can’t buy your own item");if(!inf(p)&&p.coins<i.price)bad("Not enough coins");
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
  q("INSERT INTO items(name,emoji,descr,price,stock,kind,img) VALUES(?,?,?,?,?,?,?)").run(name,String(b.emoji||"").trim().slice(0,4)||"🎁",String(b.desc||"").trim().slice(0,80),pr,st>0?st:-1,["physical","fun"].includes(b.kind)?b.kind:"normal",imgOk(b.img))},
 "cat/add"(p,b){adm(p);const n=String(b.name||"").trim().slice(0,30);if(!n)bad("Give the cat a name");
  q("INSERT INTO cats(name,img,hp,price) VALUES(?,?,?,?)").run(n,imgOk(b.img),Math.min(MAX_HP,Math.max(1,parseInt(b.hp)||50)),Math.max(0,parseInt(b.price)||0))},
 "cat/buy"(p,b){const c=q("SELECT * FROM cats WHERE id=?").get(parseInt(b.id));if(!c||c.listed===0)bad("That cat isn’t for sale");
  const own=JSON.parse(p.cats||"[]");if(own.includes(c.id))bad("You already have that cat");
  if(!inf(p)&&p.coins<c.price)bad("Not enough coins");own.push(c.id);
  q("UPDATE players SET coins=coins-?,cats=? WHERE id=?").run(inf(p)?0:c.price,JSON.stringify(own),p.id)},
 "cat/remove"(p,b){adm(p);q("UPDATE cats SET listed=0 WHERE id=?").run(parseInt(b.id))},
 "cat/relist"(p,b){adm(p);q("UPDATE cats SET listed=1 WHERE id=?").run(parseInt(b.id))},
 "move/add"(p,b){adm(p);const n=String(b.name||"").trim().slice(0,30);if(!n)bad("Give the ability a name");
  const fx=b.fx?normFx(b.fx):"";if(b.fx&&!fx)bad("That animation is too big or invalid");
  q("INSERT INTO moves(name,damage,anim,price,fx) VALUES(?,?,?,?,?)").run(n,Math.min(MAX_DMG,Math.max(1,parseInt(b.damage)||10)),ANIMS.includes(b.anim)?b.anim:"slash",Math.max(0,parseInt(b.price)||0),fx)},
 "move/equip"(p,b){const id=parseInt(b.id),cid=parseInt(b.cat);if(!owned(p).includes(id))bad("You don’t know that ability");
  if(!JSON.parse(p.cats||"[]").includes(cid))bad("You don’t own that cat");
  let e=equippedFor(p,cid);e=b.on?[...new Set([...e,id])]:e.filter(v=>v!==id);
  const m=ceqOf(p);m[cid]=e;q("UPDATE players SET ceq=? WHERE id=?").run(JSON.stringify(m),p.id)},
 "move/remove"(p,b){adm(p);q("DELETE FROM moves WHERE id=?").run(parseInt(b.id))},
 "move/buy"(p,b){const m=q("SELECT * FROM moves WHERE id=?").get(parseInt(b.id));if(!m)bad("That ability is gone");
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
  if(!m||(id&&!equippedFor(p,me.cat.id).includes(id)))bad("That ability isn’t equipped on this cat");
  const os=x.turn==="a"?"b":"a",o=x[os],oc=o.team[o.cur];oc.hp=Math.max(0,oc.hp-m.damage);sync(o);x.n++;x.ts=Date.now();
  x.last={by:me.pid,move:m.name,anim:m.anim,dmg:m.damage,fx:fxInfo(m)};x.log=[...x.log,`${me.cat.name} used ${m.name}! (${m.damage} damage)`].slice(-6);
  if(oc.hp<=0){x.log=[...x.log,`${o.name}’s ${oc.name} fainted!`].slice(-6);
   if(o.team.filter(c=>c.hp<=0).length>=Math.min(3,o.team.length)){finish(x,me.pid);post(p.name,`${me.name} beat ${o.name} in a cat battle`)}
   else{x.turn=os;x.need=os}}
  else x.turn=os},
 "battle/switch"(p,b){const x=battles.get(parseInt(b.id));if(!x||x.state!=="active")bad("No active battle");
  const side=x.a.pid===p.id?"a":x.b.pid===p.id?"b":"";if(!side)bad("That’s not your battle");
  const s=x[side],i=s.team.findIndex(c=>c.id===parseInt(b.cat));
  if(i<0||s.team[i].hp<=0||i===s.cur)bad("Pick a cat that can still fight");
  const free=x.need===side;if(!free&&(x.need||x.turn!==side))bad("It’s not your turn");
  s.cur=i;sync(s);x.n++;x.ts=Date.now();x.last=null;x.log=[...x.log,`${s.name} sent out ${s.cat.name}!`].slice(-6);
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
  q("UPDATE players SET inv=?,cats=? WHERE id=?").run(JSON.stringify(ia),JSON.stringify(na),a.id);
  q("UPDATE players SET inv=?,cats=? WHERE id=?").run(JSON.stringify(ib),JSON.stringify(nb),p.id);trades.delete(x.id)},
 "trade/cancel"(p,b){const x=trades.get(parseInt(b.id));if(!x||(x.from!==p.id&&x.to!==p.id))bad("That offer is gone");trades.delete(x.id)},
 "item/remove"(p,b){adm(p);q("DELETE FROM items WHERE id=?").run(parseInt(b.id))},
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
 "admin/clear"(p){adm(p);q("DELETE FROM messages").run()},
};
function tx(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r}catch(e){db.exec("ROLLBACK");throw e}}

// ---- live updates (Server-Sent Events)
const clients=new Set();
const pub=p=>{const a=JSON.parse(p.avatar||"{}");
 return{id:p.id,name:p.name,coins:p.coins,inv:JSON.parse(p.inv||"{}"),cats:JSON.parse(p.cats||"[]"),admin:!!p.admin,banned:!!p.banned,inf:p.id===ROOT&&!!p.infinite,avatar:Object.keys(a).length?{...a,photo:p.photo?`/avatar/${p.id}?v=${p.pv}`:""}:undefined}};
const snapshot=()=>{const on=new Set([...clients].map(c=>c.pid));return JSON.stringify({
 players:q("SELECT * FROM players").all().map(p=>({...pub(p),online:on.has(p.id)})),
 items:q("SELECT * FROM items").all().map(i=>({id:i.id,name:i.name,emoji:i.emoji,desc:i.descr,price:i.price,stock:i.stock,kind:i.kind||"normal",seller:i.seller||"",img:i.img?`/img/item/${i.id}`:""})),
 cats:q("SELECT * FROM cats").all().map(c=>({id:c.id,name:c.name,hp:c.hp,price:c.price||0,listed:c.listed!==0,img:c.img?`/img/cat/${c.id}`:""})),
 moves:q("SELECT * FROM moves").all().map(k=>({id:k.id,name:k.name,damage:k.damage,anim:k.anim,price:k.price,fx:fxInfo(k)})),
 messages:q("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 80) ORDER BY id").all()})};
function sendTo(c,base){const m=find(c.pid);if(!m)return;
 c.res.write("event: state\ndata: "+base.slice(0,-1)+',"me":'+JSON.stringify({inv:JSON.parse(m.inv),daily:m.daily,moves:JSON.parse(m.moves||"[]"),eqc:Object.fromEntries(JSON.parse(m.cats||"[]").map(id=>[id,equippedFor(m,id)])),battle:inBattle(m.id)||null,trades:[...trades.values()].filter(x=>x.from===m.id||x.to===m.id).map(({id,from,to,give,want})=>({id,from,to,give,want})),blocked:m.id===ROOT?q("SELECT id FROM blocked").all().map(r=>r.id):undefined,notes:q("SELECT id,text FROM notes WHERE pid=? ORDER BY id").all(m.id),words:m.admin?q("SELECT w FROM badwords ORDER BY w").all().map(r=>r.w):undefined})+"}\n\n")}
function broadcast(){if(!clients.size)return;const base=snapshot();for(const c of clients)sendTo(c,base)}
function push(){scheduleSave();broadcast()}
setInterval(()=>{for(const c of clients)c.res.write(": ping\n\n")},25000);
setInterval(()=>{let d=0;for(const[k,x]of trades)if(Date.now()-x.ts>18e5){trades.delete(k);d=1}for(const[k,x]of battles)if(Date.now()-x.ts>9e5){refund(x);battles.delete(k);d=1}if(d)push()},60000);

// ---- http
const INDEX=fs.readFileSync(path.join(__dirname,"index.html"));
const CSP="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const J=(res,code,o)=>{res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(o))};
const readBody=req=>new Promise((ok,no)=>{let n=0;const c=[];
 req.on("data",d=>{n+=d.length;if(n>200e3){no(new E("That’s too large"));req.destroy()}else c.push(d)});
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
   return J(res,200,{ok:1});
  }
  res.writeHead(404).end("Not found");
 }catch(e){
  if(e instanceof E)return J(res,400,{error:e.message});
  console.error(e);J(res,500,{error:"Server error"});
 }
}).listen(PORT,"0.0.0.0",()=>console.log("CatChat listening on "+PORT));
scheduleSave();
})().catch(e=>{console.error(e);process.exit(1)});
