import * as THREE from 'three';

export function createOfficeScene(container, callbacks = {}) {
  const { onTimeUpdate, onStatusUpdate, onMeetingChange } = callbacks;

// ═══════════════════════════════════════════════════
// THE AGENCY v3
// ═══════════════════════════════════════════════════
class RNG{constructor(s=42){this.s=s}n(){this.s=(this.s*16807)%2147483647;return(this.s-1)/2147483646}r(a,b){return a+this.n()*(b-a)}i(a,b){return Math.floor(this.r(a,b+1))}pick(a){return a[this.i(0,a.length-1)]}}
const rng=new RNG(2026);

const AGENTS=[
  {key:'kimi',   name:'KIMI',   color:0x2563EB,hex:'#2563EB',role:'總控調度',   screen:'terminal',hair:0x1a1a2e,shirt:0x1D4ED8,pants:0x0A1628},
  {key:'claude', name:'CLAUDE', color:0xD97757,hex:'#D97757',role:'執行 Worker', screen:'docs',    hair:0x3f3f46,shirt:0xB45309,pants:0x1a1a2e},
  {key:'codex',  name:'CODEX',  color:0x10A37F,hex:'#10A37F',role:'治理派工',   screen:'terminal',hair:0x18181b,shirt:0x065F46,pants:0x1a1a2e},
  {key:'grok',   name:'GROK',   color:0x1D9BF0,hex:'#1D9BF0',role:'生成主力',   screen:'charts',  hair:0x525252,shirt:0x0C4A6E,pants:0x212121},
  {key:'qwen',   name:'QWEN',   color:0x615CED,hex:'#615CED',role:'地端兜底',   screen:'deploy',  hair:0x292524,shirt:0x4C1D95,pants:0x1a1a2e},
  {key:'cursor', name:'CURSOR', color:0xF59E0B,hex:'#F59E0B',role:'輔助編輯',   screen:'bugs',    hair:0x44403c,shirt:0x92400E,pants:0x1a1a2e},
  {key:'gemini', name:'AGY',    color:0xFBBF24,hex:'#FBBF24',role:'量化研究',   screen:'palette', hair:0xFBBF24,shirt:0xFBBF24,pants:0xB45309,isDragon:true},
];

// Legend



// ─── SCENE ─────────────────────────────────────────
const scene=new THREE.Scene();
scene.background=new THREE.Color(0x000C1E);
scene.fog=new THREE.FogExp2(0x000C1E,0.005);
const camera=new THREE.PerspectiveCamera(30,container.clientWidth/container.clientHeight,0.1,500);
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(container.clientWidth,container.clientHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.3;
container.appendChild(renderer.domElement);

// ─── ORBIT ─────────────────────────────────────────
let isDrag=false,prev={x:0,y:0};
let sph={theta:Math.PI/4.5,phi:Math.PI/4.5,radius:34};
const tgt=new THREE.Vector3(0,1.8,0);
let autoRot=true,autoTmr;
function updCam(){const p=Math.max(.18,Math.min(Math.PI/2.3,sph.phi));sph.phi=p;camera.position.set(sph.radius*Math.sin(p)*Math.sin(sph.theta)+tgt.x,sph.radius*Math.cos(p)+tgt.y,sph.radius*Math.sin(p)*Math.cos(sph.theta)+tgt.z);camera.lookAt(tgt)}
updCam();
renderer.domElement.addEventListener('pointerdown',e=>{isDrag=true;prev={x:e.clientX,y:e.clientY};autoRot=false;clearTimeout(autoTmr)});
addEventListener('pointerup',()=>{isDrag=false;autoTmr=setTimeout(()=>autoRot=true,6000)});
addEventListener('pointermove',e=>{if(!isDrag)return;sph.theta-=(e.clientX-prev.x)*.005;sph.phi+=(e.clientY-prev.y)*.005;prev={x:e.clientX,y:e.clientY};updCam()});
renderer.domElement.addEventListener('wheel',e=>{sph.radius=Math.max(16,Math.min(50,sph.radius+e.deltaY*.03));updCam()},{passive:true});

// ─── LIGHTS ────────────────────────────────────────
const ambient=new THREE.AmbientLight(0xffffff,0.75);scene.add(ambient);
const sun=new THREE.DirectionalLight(0xFFF8F0,1.2);
sun.position.set(12,20,10);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.left=-22;sun.shadow.camera.right=22;sun.shadow.camera.top=22;sun.shadow.camera.bottom=-22;sun.shadow.bias=-.001;
scene.add(sun);
scene.add(new THREE.DirectionalLight(0xCCDDFF,0.4).translateX(-10).translateY(12));
scene.add(new THREE.HemisphereLight(0xDDE8F0,0xB0BEC5,0.4));

// ─── HELPERS ───────────────────────────────────────
const office=new THREE.Group();scene.add(office);
const M=(c,o={})=>new THREE.MeshLambertMaterial({color:c,...o});
const MB=c=>new THREE.MeshBasicMaterial({color:c});
const Glass=()=>new THREE.MeshPhysicalMaterial({color:0xBBCCDD,transparent:true,opacity:0.08,roughness:0});

// ═══════════════════════════════════════════════════
// OFFICE STRUCTURE
// ═══════════════════════════════════════════════════

// Floor
const fl=new THREE.Mesh(new THREE.BoxGeometry(26,.15,20),M(0xE8E8E8));
fl.position.y=-.075;fl.receiveShadow=true;office.add(fl);

// Carpet
const cp=new THREE.Mesh(new THREE.BoxGeometry(10,.02,8),M(0xD0D8E0));
cp.position.set(-3,.01,0);cp.receiveShadow=true;office.add(cp);

// ALL WALLS TRANSPARENT GLASS
[[0,-9.5,26,4,.06],[0,9.5,26,4,.06],[-12.5,0,.06,4,20],[12.5,0,.06,4,20]].forEach(([x,z,w,h,d])=>{
  const wall=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),Glass());
  wall.position.set(x,h/2,z);office.add(wall);
});

// Glass edge frames (subtle structural lines)
[[-12.5,-9.5],[-12.5,9.5],[12.5,-9.5],[12.5,9.5]].forEach(([x,z])=>{
  const f=new THREE.Mesh(new THREE.BoxGeometry(.08,4,.08),M(0xAABBCC));
  f.position.set(x,2,z);office.add(f);
});

// CEILING — DARK BLUE
const ceil=new THREE.Mesh(new THREE.BoxGeometry(26,.1,20),new THREE.MeshLambertMaterial({color:0x0A1628,transparent:true,opacity:0.45}));
ceil.position.y=4.05;office.add(ceil);

// Ceiling light panels (recessed) — brighter for dark bg contrast
for(let i=-2;i<=2;i++){for(let j=-1;j<=1;j++){
  const p=new THREE.Mesh(new THREE.BoxGeometry(3,.03,1),MB(0xF0F4FF));
  p.position.set(i*4.5,3.98,j*5);office.add(p);
  const pl=new THREE.PointLight(0xFFFFFF,0.25,10,1.8);
  pl.position.set(i*4.5,3.8,j*5);office.add(pl);
}}

// ═══════════════════════════════════════════════════
// MEETING ROOM (right side)
// ═══════════════════════════════════════════════════
const MRX=8,MRZ=-3;
// Glass partitions
const mrGlass=Glass();
// Left partition
let w=new THREE.Mesh(new THREE.BoxGeometry(.06,3.5,5.5),mrGlass);w.position.set(MRX-2.8,1.75,MRZ);office.add(w);
// Front — two panels with door gap
w=new THREE.Mesh(new THREE.BoxGeometry(1.8,3.5,.06),mrGlass);w.position.set(MRX-1.9,1.75,MRZ+2.75);office.add(w);
w=new THREE.Mesh(new THREE.BoxGeometry(1.8,3.5,.06),mrGlass);w.position.set(MRX+1.9,1.75,MRZ+2.75);office.add(w);

// Frame lines
[[MRX-2.8,MRZ-2.75],[MRX-2.8,MRZ+2.75],[MRX+2.8,MRZ-2.75],[MRX+2.8,MRZ+2.75]].forEach(([fx,fz])=>{
  const f=new THREE.Mesh(new THREE.BoxGeometry(.05,3.5,.05),M(0x99AABB));
  f.position.set(fx,1.75,fz);office.add(f);
});

// Meeting table
const mt=new THREE.Mesh(new THREE.BoxGeometry(3.8,.07,1.5),M(0xDDE4EC));
mt.position.set(MRX,.72,MRZ);mt.castShadow=true;mt.receiveShadow=true;office.add(mt);
[[-1.6,-.55],[-1.6,.55],[1.6,-.55],[1.6,.55]].forEach(([tx,tz])=>{
  const l=new THREE.Mesh(new THREE.BoxGeometry(.06,.7,.06),M(0xBBCCDD));
  l.position.set(MRX+tx,.35,MRZ+tz);office.add(l);
});

// Meeting chairs
const meetSeats=[
  {x:MRX-1.4,z:MRZ-1.1,ry:0},{x:MRX,z:MRZ-1.1,ry:0},{x:MRX+1.4,z:MRZ-1.1,ry:0},
  {x:MRX-1.4,z:MRZ+1.1,ry:Math.PI},{x:MRX,z:MRZ+1.1,ry:Math.PI},{x:MRX+1.4,z:MRZ+1.1,ry:Math.PI},
];
meetSeats.forEach(s=>{
  const seat=new THREE.Mesh(new THREE.BoxGeometry(.35,.04,.35),M(0x37474F));
  seat.position.set(s.x,.42,s.z);office.add(seat);
  const bk=new THREE.Mesh(new THREE.BoxGeometry(.35,.32,.04),M(0x37474F));
  const bz=s.z+(s.ry===0?-.19:.19);
  bk.position.set(s.x,.6,bz);office.add(bk);
  [-.12,.12].forEach(ox=>{[-.12,.12].forEach(oz=>{
    const l=new THREE.Mesh(new THREE.BoxGeometry(.03,.4,.03),M(0x90A4AE));
    l.position.set(s.x+ox,.2,s.z+oz);office.add(l);
  })});
});

// Whiteboard
const wbB=new THREE.Mesh(new THREE.BoxGeometry(2.6,1.1,.03),M(0xCCCCCC));
wbB.position.set(MRX,2.2,MRZ-2.73);office.add(wbB);
const wbF=new THREE.Mesh(new THREE.BoxGeometry(2.4,.96,.02),M(0xFAFAFA));
wbF.position.set(MRX,2.2,MRZ-2.71);office.add(wbF);
// WB text
const wbc=document.createElement('canvas');wbc.width=256;wbc.height=100;
const wbx=wbc.getContext('2d');
wbx.fillStyle='#FAFAFA';wbx.fillRect(0,0,256,100);
wbx.font='bold 18px sans-serif';wbx.fillStyle='#0DEEF3';wbx.fillText('RONIN',20,28);
wbx.font='11px monospace';wbx.fillStyle='#888';
wbx.fillText('Sprint 10 · Day 9',20,48);
wbx.fillText('▸ Ship preview pane',20,66);
wbx.fillText('▸ Forge wiring v2',20,82);
const wbt=new THREE.CanvasTexture(wbc);
const wbm=new THREE.Mesh(new THREE.PlaneGeometry(2.3,.92),new THREE.MeshBasicMaterial({map:wbt}));
wbm.position.set(MRX,2.2,MRZ-2.7);office.add(wbm);

// ═══════════════════════════════════════════════════
// DESK POSITIONS — agents face NEGATIVE Z (toward monitor)
// Chair is behind agent (positive Z from desk)
// Monitor is at desk front (negative Z from desk center)
// ═══════════════════════════════════════════════════
const desks=[
  {x:-8, z:-3},  // KIMI（總控位，帶光環）
  {x:-4, z:-3},  // CLAUDE
  {x:0,  z:-3},  // CODEX
  {x:-8, z:1.5}, // GROK
  {x:-4, z:1.5}, // QWEN
  {x:0,  z:1.5}, // CURSOR
  {x:-8, z:6},   // AGY（龍窩）
];

// ═══════════════════════════════════════════════════
// CHARACTER BUILDER
// ═══════════════════════════════════════════════════

// ═══ AGY 小黃龍：大眼睛 + 流口水 + 小翅膀 ═══
function buildDragon(agent, standing=false){
  const g=new THREE.Group();
  const YELLOW=0xFBBF24, LIGHT=0xFDE68A, WHITE=0xFFFFFF, DARK=0x1a1a2e, DROOL=0x7DD3FC;
  const bodyH = standing ? .5 : .42;
  // 圓胖身體
  const body=new THREE.Mesh(new THREE.SphereGeometry(.22,12,12),M(YELLOW));
  body.scale.set(1,.9,1);body.position.y=bodyH;body.castShadow=true;g.add(body);
  // 肚皮
  const belly=new THREE.Mesh(new THREE.SphereGeometry(.16,10,10),M(LIGHT));
  belly.scale.set(.8,.8,.6);belly.position.set(0,bodyH-.03,.1);g.add(belly);
  // 大頭
  const head=new THREE.Mesh(new THREE.SphereGeometry(.19,12,12),M(YELLOW));
  head.position.y=bodyH+.3;head.castShadow=true;g.add(head);
  // 大眼睛（誇張大）
  [-1,1].forEach(sd=>{
    const eye=new THREE.Mesh(new THREE.SphereGeometry(.075,10,10),MB(WHITE));
    eye.position.set(sd*.09,bodyH+.35,.14);g.add(eye);
    const pup=new THREE.Mesh(new THREE.SphereGeometry(.032,8,8),MB(DARK));
    pup.position.set(sd*.09,bodyH+.34,.2);g.add(pup);
    // 呆滯高光
    const hl=new THREE.Mesh(new THREE.SphereGeometry(.014,6,6),MB(WHITE));
    hl.position.set(sd*.075,bodyH+.37,.215);g.add(hl);
  });
  // 傻傻的微笑
  const mouth=new THREE.Mesh(new THREE.BoxGeometry(.1,.02,.02),MB(0x92400E));
  mouth.position.set(0,bodyH+.22,.18);g.add(mouth);
  // 口水滴（動畫用）
  const drool=new THREE.Mesh(new THREE.SphereGeometry(.028,8,8),new THREE.MeshPhysicalMaterial({color:DROOL,transparent:true,opacity:.85,roughness:.1}));
  drool.scale.set(.7,1.4,.7);drool.position.set(.06,bodyH+.16,.17);g.add(drool);
  g.userData.drool=drool;
  // 小角
  [-1,1].forEach(sd=>{
    const horn=new THREE.Mesh(new THREE.ConeGeometry(.03,.08,6),M(LIGHT));
    horn.position.set(sd*.08,bodyH+.48,0);g.add(horn);
  });
  // 小翅膀
  [-1,1].forEach(sd=>{
    const wing=new THREE.Mesh(new THREE.BoxGeometry(.04,.12,.16),M(LIGHT));
    wing.position.set(sd*.2,bodyH+.1,-.1);wing.rotation.z=sd*.6;g.add(wing);
    if(!g.userData.wings)g.userData.wings=[];g.userData.wings.push(wing);
  });
  // 尾巴
  const tail=new THREE.Mesh(new THREE.ConeGeometry(.05,.22,8),M(YELLOW));
  tail.rotation.x=Math.PI/2.4;tail.position.set(0,bodyH-.15,-.24);g.add(tail);
  // 腳
  [-1,1].forEach(sd=>{
    const foot=new THREE.Mesh(new THREE.SphereGeometry(.05,8,8),M(LIGHT));
    foot.position.set(sd*.09,.05,.08);g.add(foot);
  });
  // 名牌徽章
  const badge=new THREE.Mesh(new THREE.BoxGeometry(.05,.05,.05),MB(agent.color));
  badge.position.set(.2,bodyH,.1);g.add(badge);
  return g;
}

function buildChar(agent, standing=false){
  if(agent.isDragon) return buildDragon(agent,standing);
  const g=new THREE.Group();
  const skin=0xF2C894,skinD=0xE5B57E;
  const MS=(c,o={})=>new THREE.MeshStandardMaterial({color:c,roughness:.75,metalness:.02,...o});
  const cap=(r,len,c)=>{const m=new THREE.Mesh(new THREE.CapsuleGeometry(r,len,4,10),MS(c));m.castShadow=true;return m};
  const sph=(r,c,mb)=>{const m=new THREE.Mesh(new THREE.SphereGeometry(r,14,14),mb?MB(c):MS(c,{roughness:.5}));return m};

  if(standing){
    // 腿（膠囊）
    [-1,1].forEach(sd=>{
      const leg=cap(.05,.26,agent.pants);
      leg.position.set(sd*.085,.24,0);g.add(leg);
      if(sd<0){leg.userData.isLeg=true;leg.userData.phase=0}
      else{leg.userData.isLeg=true;leg.userData.phase=Math.PI}
      const shoe=sph(.055,0x27272A);shoe.scale.set(1,.6,1.5);shoe.position.set(sd*.085,.035,.03);g.add(shoe);
    });
    // 身體（膠囊，微收腰）
    const torso=cap(.15,.26,agent.shirt);
    torso.position.set(0,.62,0);g.add(torso);
    g.userData.torso=torso;
    // 領子
    const col=new THREE.Mesh(new THREE.TorusGeometry(.08,.022,8,16),MS(0xFFFFFF));
    col.rotation.x=Math.PI/2;col.position.set(0,.82,0);g.add(col);
    // 手臂（膠囊，微張）
    [-1,1].forEach(sd=>{
      const arm=cap(.04,.22,agent.shirt);
      arm.position.set(sd*.21,.62,0);arm.rotation.z=sd*-.18;g.add(arm);
      const hand=sph(.042,skin);hand.position.set(sd*.25,.44,0);g.add(hand);
    });
    // 頭（圓球）
    const head=sph(.13,skin);head.position.set(0,.95,0);head.castShadow=true;g.add(head);
    g.userData.head=head;
    // 鼻子
    const nose=sph(.018,skinD);nose.position.set(0,.94,.125);g.add(nose);
    // 頭髮（半圓罩 + 後片）
    const hair=sph(.135,agent.hair);hair.scale.set(1,.72,1);hair.position.set(0,1.0,-.015);g.add(hair);
    const hairBack=new THREE.Mesh(new THREE.BoxGeometry(.2,.16,.05),MS(agent.hair));
    hairBack.position.set(0,.93,-.1);g.add(hairBack);
    // 眼睛（眼白 + 瞳孔 + 高光）
    [-1,1].forEach(sd=>{
      const eye=sph(.028,0xFFFFFF,true);eye.position.set(sd*.055,.965,.115);g.add(eye);
      const pup=sph(.013,0x1A1A2E,true);pup.position.set(sd*.055,.958,.137);g.add(pup);
    });
    // 眉毛
    [-1,1].forEach(sd=>{
      const brow=new THREE.Mesh(new THREE.BoxGeometry(.045,.008,.008),MS(agent.hair));
      brow.position.set(sd*.055,1.0,.122);brow.rotation.z=sd*-.1;g.add(brow);
    });
    // 徽章
    const badge=sph(.03,agent.color,true);badge.position.set(.1,.68,.14);g.add(badge);
  } else {
    // ── 坐姿（面朝 -Z 朝螢幕）──
    // 大腿（水平膠囊）
    [-1,1].forEach(sd=>{
      const thigh=cap(.055,.14,agent.pants);
      thigh.rotation.x=Math.PI/2;thigh.position.set(sd*.09,.43,-.06);g.add(thigh);
      const shin=cap(.045,.16,agent.pants);
      shin.position.set(sd*.09,.22,-.16);g.add(shin);
      const shoe=sph(.055,0x27272A);shoe.scale.set(1,.6,1.5);shoe.position.set(sd*.09,.06,-.16);g.add(shoe);
    });
    // 身體
    const torso=cap(.15,.2,agent.shirt);
    torso.position.set(0,.66,0);g.add(torso);
    g.userData.torso=torso;
    // 領子
    const col=new THREE.Mesh(new THREE.TorusGeometry(.08,.02,8,16),MS(0xFFFFFF));
    col.rotation.x=Math.PI/2;col.position.set(0,.84,0);g.add(col);
    // 手臂前伸打鍵盤（-Z 方向）
    [-1,1].forEach(sd=>{
      const ua=cap(.04,.12,agent.shirt);
      ua.position.set(sd*.21,.68,-.03);ua.rotation.x=.4;g.add(ua);
      const fa=cap(.035,.14,skin);
      fa.rotation.x=Math.PI/2.2;fa.position.set(sd*.2,.56,-.14);g.add(fa);
      const hand=sph(.04,skin);hand.position.set(sd*.2,.55,-.24);g.add(hand);
      g.userData['armL'+(sd<0?'0':'1')]=fa;
    });
    // 頭
    const head=sph(.13,skin);head.position.set(0,.98,0);head.castShadow=true;g.add(head);
    g.userData.head=head;
    const nose=sph(.018,skinD);nose.position.set(0,.97,-.125);g.add(nose);
    // 頭髮
    const hair=sph(.135,agent.hair);hair.scale.set(1,.72,1);hair.position.set(0,1.03,.015);g.add(hair);
    const hairBack=new THREE.Mesh(new THREE.BoxGeometry(.2,.16,.05),MS(agent.hair));
    hairBack.position.set(0,.96,.1);g.add(hairBack);
    // 眼睛（朝 -Z 看螢幕）
    [-1,1].forEach(sd=>{
      const eye=sph(.028,0xFFFFFF,true);eye.position.set(sd*.055,.99,-.115);g.add(eye);
      const pup=sph(.013,0x1A1A2E,true);pup.position.set(sd*.055,.982,-.137);g.add(pup);
    });
    // 徽章
    const badge=sph(.03,agent.color,true);badge.position.set(.1,.72,-.12);g.add(badge);
  }
  return g;
}

// ═══════════════════════════════════════════════════
// BUILD ALL DESKS + AGENTS
// ═══════════════════════════════════════════════════
const screenData=[];
const agentData=[]; // {sittingChar, walker, home, label, dGlow, state, timer, walkTarget, walkPath, walkIdx}

AGENTS.forEach((agent,idx)=>{
  const dp=desks[idx];
  const ax=dp.x, az=dp.z;

  // ── Desk (monitor at -Z side, chair at +Z side)
  // Legs
  [[-0.65,-.3],[.65,-.3],[-.65,.3],[.65,.3]].forEach(([lx,lz])=>{
    const l=new THREE.Mesh(new THREE.BoxGeometry(.06,.7,.06),M(0xBBCCDD));
    l.position.set(ax+lx,.35,az+lz);l.castShadow=true;office.add(l);
  });
  // Top
  const dTop=new THREE.Mesh(new THREE.BoxGeometry(1.5,.05,.75),M(0xE8ECF0));
  dTop.position.set(ax,.73,az);dTop.castShadow=true;dTop.receiveShadow=true;office.add(dTop);
  // Front panel
  const dFront=new THREE.Mesh(new THREE.BoxGeometry(1.5,.38,.03),M(0xDDE4EC));
  dFront.position.set(ax,.52,az-.36);office.add(dFront);

  // ── Monitor (at -Z side of desk)
  const monBase=new THREE.Mesh(new THREE.BoxGeometry(.25,.02,.12),M(0xAABBCC));
  monBase.position.set(ax,.77,az-.2);office.add(monBase);
  const monStand=new THREE.Mesh(new THREE.BoxGeometry(.03,.22,.03),M(0xAABBCC));
  monStand.position.set(ax,.88,az-.2);office.add(monStand);
  const monBody=new THREE.Mesh(new THREE.BoxGeometry(.85,.52,.03),M(0x2A2A2A));
  monBody.position.set(ax,1.28,az-.24);monBody.castShadow=true;office.add(monBody);

  // Screen
  const cv=document.createElement('canvas');cv.width=128;cv.height=80;
  const cx=cv.getContext('2d');
  const tex=new THREE.CanvasTexture(cv);tex.minFilter=THREE.LinearFilter;
  const sf=new THREE.Mesh(new THREE.PlaneGeometry(.78,.46),new THREE.MeshBasicMaterial({map:tex}));
  sf.position.set(ax,1.28,az-.22);office.add(sf);
  screenData.push({canvas:cv,ctx:cx,tex,type:agent.screen,hex:agent.hex});

  // Keyboard
  const kb=new THREE.Mesh(new THREE.BoxGeometry(.42,.02,.13),M(0x333333));
  kb.position.set(ax,.77,az+.02);office.add(kb);
  for(let r=0;r<3;r++)for(let c=0;c<8;c++){
    const k=new THREE.Mesh(new THREE.BoxGeometry(.04,.008,.03),M(0x444444));
    k.position.set(ax-.15+c*.042,.785,az-.03+r*.035);office.add(k);
  }
  // Mouse
  const ms=new THREE.Mesh(new THREE.BoxGeometry(.06,.02,.09),M(0x333333));
  ms.position.set(ax+.42,.77,az+.02);office.add(ms);
  // Mug
  const mug=new THREE.Mesh(new THREE.BoxGeometry(.06,.08,.06),M(idx%2?0xFFFFFF:0x666666));
  mug.position.set(ax+.55,.8,az+.12);office.add(mug);
  const coff=new THREE.Mesh(new THREE.BoxGeometry(.05,.01,.05),M(0x4E342E));
  coff.position.set(ax+.55,.84,az+.12);office.add(coff);

  // ── Chair (at +Z side)
  const cz=az+.55;
  const cSeat=new THREE.Mesh(new THREE.BoxGeometry(.4,.04,.4),M(0x37474F));
  cSeat.position.set(ax,.44,cz);office.add(cSeat);
  const cBack=new THREE.Mesh(new THREE.BoxGeometry(.4,.42,.04),M(0x37474F));
  cBack.position.set(ax,.67,cz+.19);office.add(cBack);
  [-.14,.14].forEach(ox=>{[-.14,.14].forEach(oz=>{
    const l=new THREE.Mesh(new THREE.BoxGeometry(.03,.42,.03),M(0x90A4AE));
    l.position.set(ax+ox,.21,cz+oz);office.add(l);
  })});
  [-1,1].forEach(s=>{
    const ar=new THREE.Mesh(new THREE.BoxGeometry(.04,.03,.28),M(0x546E7A));
    ar.position.set(ax+s*.2,.47,cz);office.add(ar);
  });

  // ── Desk underglow
  const dGlow=new THREE.PointLight(agent.color,0.2,2.5,2);
  dGlow.position.set(ax,.3,az);office.add(dGlow);

  // ── Sitting character — faces -Z (toward monitor)
  // Character local +Z is character's front. We rotate PI so front faces -Z world.
  const sittingChar=buildChar(agent,false);
  sittingChar.position.set(ax,0,az+.55);
  // No rotation needed — sitting char built to face -Z (toward monitor)
  office.add(sittingChar);

  // ── Floating Label
  const lc=document.createElement('canvas');lc.width=256;lc.height=64;
  const lctx=lc.getContext('2d');
  lctx.clearRect(0,0,256,64);
  lctx.font='600 20px Orbitron,monospace';lctx.textAlign='center';
  lctx.fillStyle=agent.hex;lctx.shadowColor=agent.hex;lctx.shadowBlur=8;
  lctx.fillText(agent.name,128,26);
  lctx.shadowBlur=0;lctx.font='300 11px monospace';lctx.fillStyle='rgba(100,120,140,.7)';
  lctx.fillText(agent.role,128,46);
  const lTex=new THREE.CanvasTexture(lc);lTex.minFilter=THREE.LinearFilter;
  const label=new THREE.Sprite(new THREE.SpriteMaterial({map:lTex,transparent:true,depthTest:false}));
  label.scale.set(1.4,.35,1);
  label.position.set(ax,1.8,az+.55);
  office.add(label);

  // ── Walker (standing character, hidden initially)
  const walker=buildChar(agent,true);
  walker.visible=false;
  office.add(walker);

  sittingChar.userData.agentKey=agent.key;
  walker.userData.agentKey=agent.key;
  agentData.push({
    sittingChar, walker, label, dGlow,
    home:{x:ax,z:az+.55},
    state:'sitting', // sitting | walking_out | walking_back
    timer: 4 + rng.r(0,12), // seconds until next action
    walkTarget:null,
    agent
  });
});

// ═══════════════════════════════════════════════════
// WALK DESTINATIONS
// ═══════════════════════════════════════════════════
const walkDestinations=[
  {x:2,z:7.5},   // front area
  {x:-10,z:0},   // water cooler
  {x:-2,z:-7},   // back window
  {x:4,z:5},     // right front
  {x:-6,z:7},    // left front
  {x:3,z:0},     // center
];


// ═══ 休息室（額度用畢的夥伴來這睡覺）═══
const LOUNGE={x:5.5,z:6.5};
{
  // 地毯
  const rug=new THREE.Mesh(new THREE.BoxGeometry(4.5,.03,3.4),M(0xFDE68A));
  rug.position.set(LOUNGE.x,.02,LOUNGE.z);rug.receiveShadow=true;office.add(rug);
  // 沙發
  const couchBase=new THREE.Mesh(new THREE.BoxGeometry(2.6,.35,.9),M(0x7C2D12));
  couchBase.position.set(LOUNGE.x,.25,LOUNGE.z);couchBase.castShadow=true;office.add(couchBase);
  const couchBack=new THREE.Mesh(new THREE.BoxGeometry(2.6,.5,.18),M(0x7C2D12));
  couchBack.position.set(LOUNGE.x,.62,LOUNGE.z-.38);office.add(couchBack);
  [-.9,.9].forEach(ox=>{
    const arm=new THREE.Mesh(new THREE.BoxGeometry(.18,.3,.8),M(0x9A3412));
    arm.position.set(LOUNGE.x+ox,.5,LOUNGE.z);office.add(arm);
  });
  // 抱枕
  const pillow=new THREE.Mesh(new THREE.BoxGeometry(.3,.12,.3),M(0xFBBF24));
  pillow.position.set(LOUNGE.x-.9,.48,LOUNGE.z);office.add(pillow);
  // 小茶几 + 零食
  const table=new THREE.Mesh(new THREE.BoxGeometry(.7,.3,.5),M(0x92400E));
  table.position.set(LOUNGE.x,.15,LOUNGE.z+1.1);office.add(table);
  const snack=new THREE.Mesh(new THREE.BoxGeometry(.12,.06,.12),M(0xEF4444));
  snack.position.set(LOUNGE.x,.34,LOUNGE.z+1.05);office.add(snack);
  // 立燈
  const lampPole=new THREE.Mesh(new THREE.BoxGeometry(.04,1.3,.04),M(0x71717A));
  lampPole.position.set(LOUNGE.x+1.8,.65,LOUNGE.z-1);office.add(lampPole);
  const lampHead=new THREE.Mesh(new THREE.SphereGeometry(.12,8,8),MB(0xFDE68A));
  lampHead.position.set(LOUNGE.x+1.8,1.35,LOUNGE.z-1);office.add(lampHead);
  const lampLight=new THREE.PointLight(0xFDE68A,.5,4,2);
  lampLight.position.set(LOUNGE.x+1.8,1.3,LOUNGE.z-1);office.add(lampLight);
  // 招牌
  const signC=document.createElement('canvas');signC.width=256;signC.height=64;
  const sc=signC.getContext('2d');sc.font='600 22px monospace';sc.textAlign='center';
  sc.fillStyle='#92400E';sc.fillText('休息室 LOUNGE',128,40);
  const signT=new THREE.CanvasTexture(signC);
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(1.6,.4),new THREE.MeshBasicMaterial({map:signT,transparent:true}));
  sign.position.set(LOUNGE.x,1.9,LOUNGE.z-1.2);office.add(sign);
}

// 每位角色在休息室的睡姿（躺在沙發上）
const sleepers={};
function getSleeper(ad){
  if(!sleepers[ad.agent.key]){
    const ch=buildChar(ad.agent,false);
    ch.rotation.x=-Math.PI/2;         // 躺平
    ch.rotation.z=Math.PI;            // 腳朝沙發尾
    const i=Object.keys(sleepers).length;
    ch.position.set(LOUNGE.x-.8+i*.8,.62,LOUNGE.z+.1);
    ch.userData.agentKey=ad.agent.key;ch.visible=false;office.add(ch);
    // Zzz 浮標
    const zc=document.createElement('canvas');zc.width=128;zc.height=64;
    const zx=zc.getContext('2d');zx.font='600 26px monospace';zx.textAlign='center';
    zx.fillStyle='#A1A1AA';zx.fillText('Z z z',64,40);
    const zt=new THREE.CanvasTexture(zc);
    const zs=new THREE.Sprite(new THREE.SpriteMaterial({map:zt,transparent:true,depthTest:false,opacity:.9}));
    zs.scale.set(.7,.35,1);zs.position.set(LOUNGE.x-.8+i*.8,1.25,LOUNGE.z+.1);zs.visible=false;
    office.add(zs);
    sleepers[ad.agent.key]={char:ch,zzz:zs,phase:i*1.7};
  }
  return sleepers[ad.agent.key];
}

// ═══ 真實狀態驅動（來自 ai-hub status.json）═══
// active=工作 | idle=偷懶亂晃 | rate_limited=休息室睡覺 | unknown=外出
let agentStatus={};
function desiredState(key){return agentStatus[key]||'active'}

// ═══════════════════════════════════════════════════
// WALKING SYSTEM
// ═══════════════════════════════════════════════════
function updateWalkers(delta){
  agentData.forEach(ad=>{
    const want=desiredState(ad.agent.key);   // active|idle|rate_limited|unknown
    const st=ad.state;
    const speed=1.6*delta;
    const t=performance.now()*.01;

    const gait=()=>{ad.walker.children.forEach(c=>{if(c.userData&&c.userData.isLeg)c.position.z=Math.sin(t+c.userData.phase)*.08})};
    const resetGait=()=>{ad.walker.children.forEach(c=>{if(c.userData&&c.userData.isLeg)c.position.z=0})};
    const walkTo=(tx,tz,sp)=>{const dx=tx-ad.walker.position.x,dz=tz-ad.walker.position.z;const dist=Math.sqrt(dx*dx+dz*dz);
      if(dist<.2)return true;
      const nx=dx/dist,nz=dz/dist;ad.walker.position.x+=nx*sp;ad.walker.position.z+=nz*sp;ad.walker.rotation.y=Math.atan2(nx,nz);gait();
      ad.label.position.set(ad.walker.position.x,1.3,ad.walker.position.z);return false};

    // ── 狀態切換（由真實資料觸發）──
    if(st==='sitting'){
      if(want==='rate_limited'){
        ad.state='to_lounge';ad.sittingChar.visible=false;ad.walker.visible=true;
        ad.walker.position.set(ad.home.x,0,ad.home.z);
      } else if(want==='unknown'){
        ad.state='leaving';ad.sittingChar.visible=false;ad.walker.visible=true;
        ad.walker.position.set(ad.home.x,0,ad.home.z);ad.walkTarget={x:-12,z:8};
      } else if(want==='active'){
        ad.timer=Math.max(ad.timer,3);   // 工作中：釘在桌前
      } else {
        // idle：偷懶模式 —— 計時到就起來亂晃
        ad.timer-=delta;
        if(ad.timer<=0){
          ad.state='walking_out';ad.sittingChar.visible=false;ad.walker.visible=true;
          ad.walker.position.set(ad.home.x,0,ad.home.z);
          const dest=walkDestinations[rng.i(0,walkDestinations.length-1)];
          ad.walkTarget={x:dest.x+rng.r(-.5,.5),z:dest.z+rng.r(-.5,.5)};
          ad.walkPause=0;
        }
      }
    } else if(st==='walking_out'){
      if(want==='active'){ad.state='walking_back';}
      else if(want==='rate_limited'){ad.state='to_lounge';}
      else if(want==='unknown'){ad.state='leaving';ad.walkTarget={x:-12,z:8};}
      else{
        const arrived=walkTo(ad.walkTarget.x,ad.walkTarget.z,speed);
        if(arrived){
          ad.walkPause+=delta;
          if(ad.walkPause>2+rng.r(0,2))ad.state='walking_back';
        }
      }
    } else if(st==='walking_back'){
      if(want==='rate_limited'){ad.state='to_lounge';}
      else if(want==='unknown'){ad.state='leaving';ad.walkTarget={x:-12,z:8};}
      else{
        const arrived=walkTo(ad.home.x,ad.home.z,speed);
        if(arrived){
          ad.state='sitting';ad.walker.visible=false;ad.sittingChar.visible=true;
          ad.label.position.set(ad.home.x,1.8,ad.home.z);
          ad.timer=6+rng.r(0,14);resetGait();
        }
      }
    } else if(st==='to_lounge'){
      const spot={x:LOUNGE.x-.8+Object.keys(sleepers).indexOf(ad.agent.key)*.8,z:LOUNGE.z+.35};
      const arrived=walkTo(spot.x,spot.z,speed*1.2);
      if(arrived){
        ad.state='sleeping';ad.walker.visible=false;resetGait();
        const sl=getSleeper(ad);sl.char.visible=true;sl.zzz.visible=true;
        ad.label.position.set(spot.x,1.5,spot.z);
      }
    } else if(st==='sleeping'){
      if(want==='active'||want==='idle'){
        const sl=getSleeper(ad);sl.char.visible=false;sl.zzz.visible=false;
        ad.walker.visible=true;ad.walker.position.set(LOUNGE.x,0,LOUNGE.z+.35);
        ad.state='walking_back';
      } else if(want==='unknown'){
        const sl=getSleeper(ad);sl.char.visible=false;sl.zzz.visible=false;
        ad.state='offsite';ad.label.position.set(ad.home.x,1.8,ad.home.z);
      }
    } else if(st==='leaving'){
      const arrived=walkTo(ad.walkTarget.x,ad.walkTarget.z,speed*1.25);
      if(arrived){ad.walker.visible=false;ad.state='offsite';ad.label.position.set(ad.home.x,1.8,ad.home.z);}
    } else if(st==='offsite'){
      if(want==='active'||want==='idle'){
        ad.walker.visible=true;ad.walker.position.set(-12,0,8);ad.state='walking_back';
      } else if(want==='rate_limited'){
        ad.walker.visible=true;ad.walker.position.set(-12,0,8);ad.state='to_lounge';
      }
    }
  });
}

// ═══════════════════════════════════════════════════
// MEETING LOGIC
// ═══════════════════════════════════════════════════
let inMeeting=false;
// badge handled by React
const meetChars=[];
// Pre-build meeting room sitting chars for first 6 agents
AGENTS.slice(0,6).forEach((agent,i)=>{
  const mc=buildChar(agent,false);
  const s=meetSeats[i];
  mc.position.set(s.x,0,s.z);
  // Sitting char eyes face -Z in local space.
  // Back row (lower z, behind table): need to face +Z toward table → rotation.y = PI
  // Front row (higher z, in front of table): need to face -Z toward table → rotation.y = 0
  mc.rotation.y = s.z < MRZ ? Math.PI : 0;
  mc.visible=false;
  office.add(mc);
  meetChars.push(mc);
});

function updateMeeting(minutes){return;
  const shouldMeet=(minutes>=600&&minutes<=630)||(minutes>=840&&minutes<=870);
  if(shouldMeet&&!inMeeting){
    inMeeting=true;if(onMeetingChange)onMeetingChange(true);
    meetChars.forEach(c=>c.visible=true);
    // Pause walking for meeting agents
    agentData.slice(0,6).forEach(ad=>{
      if(ad.state!=='sitting'){
        ad.walker.visible=false;ad.sittingChar.visible=false;
      } else { ad.sittingChar.visible=false; }
      ad.state='meeting';
    });
  } else if(!shouldMeet&&inMeeting){
    inMeeting=false;if(onMeetingChange)onMeetingChange(false);
    meetChars.forEach(c=>c.visible=false);
    agentData.slice(0,6).forEach(ad=>{
      ad.state='sitting';ad.sittingChar.visible=true;
      ad.label.position.set(ad.home.x,1.8,ad.home.z);
      ad.timer=3+rng.r(0,6);
    });
  }
}

// ═══════════════════════════════════════════════════
// OFFICE DETAILS
// ═══════════════════════════════════════════════════
// Water cooler
let wc=new THREE.Mesh(new THREE.BoxGeometry(.28,.55,.28),M(0xE0E0E0));
wc.position.set(-10.5,.275,0);office.add(wc);
let wt=new THREE.Mesh(new THREE.BoxGeometry(.22,.25,.22),M(0x90CAF9));
wt.position.set(-10.5,.675,0);office.add(wt);

// Plants
function addPlant(px,pz,big=false){
  const s=big?1.3:1;
  const pot=new THREE.Mesh(new THREE.BoxGeometry(.28*s,.22*s,.28*s),M(0xECEFF1));
  pot.position.set(px,.11*s,pz);pot.castShadow=true;office.add(pot);
  for(let i=0;i<(big?4:3);i++){
    const leaf=new THREE.Mesh(new THREE.BoxGeometry((.12+rng.r(0,.12))*s,(.2+rng.r(0,.25))*s,.12*s),M(rng.n()>.5?0x66BB6A:0x388E3C));
    leaf.position.set(px+rng.r(-.06,.06)*s,.32*s+i*.18*s,pz+rng.r(-.06,.06)*s);
    leaf.rotation.y=rng.r(0,Math.PI);leaf.castShadow=true;office.add(leaf);
  }
}
addPlant(-11,8,true);addPlant(-11,-8);addPlant(11,-8);addPlant(-2,-8);addPlant(-6,8,true);

// Bookshelf
for(let r=0;r<3;r++){
  const sh=new THREE.Mesh(new THREE.BoxGeometry(1.8,.04,.3),M(0xDDE4EC));
  sh.position.set(-11.5,.5+r*.55,-5);office.add(sh);
  for(let b=0;b<5;b++){
    const bk=new THREE.Mesh(new THREE.BoxGeometry(.12,.35+rng.r(0,.15),.22),M([0x448AFF,0xFF5252,0xF5A623,0x7C4DFF,0x00E676][b]));
    bk.position.set(-12.2+b*.3,.5+r*.55+.2,-5);office.add(bk);
  }
}

// ═══════════════════════════════════════════════════
// RECEPTION DESK WITH RONIN LOGO (front-right, near meeting room)
// ═══════════════════════════════════════════════════
const reception=new THREE.Group();
const RCX=8,RCZ=6.5;
// Main desk body (curved front)
const rcDesk=new THREE.Mesh(new THREE.BoxGeometry(2.5,.9,.6),M(0x1A2A3A));
rcDesk.position.set(RCX,.45,RCZ);rcDesk.castShadow=true;reception.add(rcDesk);
// Top surface
const rcTop=new THREE.Mesh(new THREE.BoxGeometry(2.6,.04,.7),M(0xDDE4EC));
rcTop.position.set(RCX,.92,RCZ);reception.add(rcTop);
// Side panel
const rcSide=new THREE.Mesh(new THREE.BoxGeometry(.6,.9,.04),M(0x1A2A3A));
rcSide.position.set(RCX+1.25,.45,RCZ-.3);reception.add(rcSide);

// RONIN logo on front — load from actual image
const roninLogoTex=new THREE.TextureLoader().load('./ronin-logo.png');
roninLogoTex.minFilter=THREE.LinearFilter;
const rcLogoMesh=new THREE.Mesh(
  new THREE.PlaneGeometry(1.8,.6),
  new THREE.MeshBasicMaterial({map:roninLogoTex,transparent:true})
);
rcLogoMesh.position.set(RCX,.5,RCZ+.31);reception.add(rcLogoMesh);

// Teal glow strip under desk front
const rcGlow=new THREE.Mesh(new THREE.BoxGeometry(2.2,.02,.02),MB(0x0DEEF3));
rcGlow.position.set(RCX,.05,RCZ+.3);reception.add(rcGlow);
const rcLight=new THREE.PointLight(0x0DEEF3,0.4,3.5,2);
rcLight.position.set(RCX,.1,RCZ+.5);reception.add(rcLight);

// Reception monitor (behind desk, facing NEXUS)
const rcMonBase=new THREE.Mesh(new THREE.BoxGeometry(.2,.02,.1),M(0xAABBCC));
rcMonBase.position.set(RCX-.4,.95,RCZ+.05);reception.add(rcMonBase);
const rcMonStand=new THREE.Mesh(new THREE.BoxGeometry(.03,.18,.03),M(0xAABBCC));
rcMonStand.position.set(RCX-.4,1.05,RCZ+.05);reception.add(rcMonStand);
const rcMonBody=new THREE.Mesh(new THREE.BoxGeometry(.6,.4,.03),M(0x2A2A2A));
rcMonBody.position.set(RCX-.4,1.35,RCZ+.08);reception.add(rcMonBody);
// Screen glow
const rcScreenGlow=new THREE.Mesh(new THREE.BoxGeometry(.55,.35,.01),MB(0x0A1628));
rcScreenGlow.position.set(RCX-.4,1.35,RCZ+.06);reception.add(rcScreenGlow);

// Keyboard + mouse
const rcKb=new THREE.Mesh(new THREE.BoxGeometry(.3,.02,.1),M(0x333333));
rcKb.position.set(RCX-.4,.95,RCZ+.15);reception.add(rcKb);
const rcMouse=new THREE.Mesh(new THREE.BoxGeometry(.05,.02,.07),M(0x333333));
rcMouse.position.set(RCX-.1,.95,RCZ+.15);reception.add(rcMouse);

// Reception chair (positioned in NEXUS fix above)
const rcChairSeat=new THREE.Mesh(new THREE.BoxGeometry(.4,.04,.4),M(0x37474F));
reception.add(rcChairSeat);
const rcChairBack=new THREE.Mesh(new THREE.BoxGeometry(.4,.42,.04),M(0x37474F));
reception.add(rcChairBack);

// RECEPTION AGENT — "NEXUS" (white/silver, the coordinator)
const nexusAgent={name:'NEXUS',color:0xCCDDEE,hex:'#CCDDEE',role:'The Coordinator',hair:0x555555,shirt:0x546E7A,pants:0x263238};
const nexusChar=buildChar(nexusAgent,false);
nexusChar.position.set(RCX-.4,0,RCZ-.4); // behind desk
nexusChar.rotation.y=Math.PI; // face +Z toward visitors
reception.add(nexusChar);

// Reception chair (behind desk)
rcChairSeat.position.set(RCX-.4,.44,RCZ-.4);
rcChairBack.position.set(RCX-.4,.67,RCZ-.59);

// Nexus label
const nxLC=document.createElement('canvas');nxLC.width=256;nxLC.height=64;
const nxCtx=nxLC.getContext('2d');
nxCtx.clearRect(0,0,256,64);
nxCtx.font='600 20px Orbitron,monospace';nxCtx.textAlign='center';
nxCtx.fillStyle='#CCDDEE';nxCtx.shadowColor='#CCDDEE';nxCtx.shadowBlur=8;
nxCtx.fillText('NEXUS',128,26);
nxCtx.shadowBlur=0;nxCtx.font='300 11px monospace';nxCtx.fillStyle='rgba(180,200,220,.7)';
nxCtx.fillText('The Coordinator',128,46);
const nxTex=new THREE.CanvasTexture(nxLC);nxTex.minFilter=THREE.LinearFilter;
const nxLabel=new THREE.Sprite(new THREE.SpriteMaterial({map:nxTex,transparent:true,depthTest:false}));
nxLabel.scale.set(1.4,.35,1);nxLabel.position.set(RCX-.4,1.8,RCZ-.4);
reception.add(nxLabel);

office.add(reception);

// ═══════════════════════════════════════════════════
// SOFA / LOUNGE AREA (right of reception, placed vertically)
// ═══════════════════════════════════════════════════
const lounge=new THREE.Group();
const SX=10.5,SZ=6;
// Sofa base (rotated — depth along Z axis)
const sofaBase=new THREE.Mesh(new THREE.BoxGeometry(.7,.35,2),M(0x37474F));
sofaBase.position.set(SX,.175,SZ);sofaBase.castShadow=true;lounge.add(sofaBase);
// Seat cushion
const sofaSeat=new THREE.Mesh(new THREE.BoxGeometry(.55,.12,1.9),M(0x455A64));
sofaSeat.position.set(SX-.05,.41,SZ);lounge.add(sofaSeat);
// Back cushion (against wall side)
const sofaBack=new THREE.Mesh(new THREE.BoxGeometry(.12,.4,1.9),M(0x455A64));
sofaBack.position.set(SX+.35,.55,SZ);lounge.add(sofaBack);
// Armrests
[-1,1].forEach(s=>{
  const arm=new THREE.Mesh(new THREE.BoxGeometry(.7,.25,.15),M(0x37474F));
  arm.position.set(SX,.3,SZ+s*1.05);lounge.add(arm);
});
// Coffee table (in front of sofa, along Z)
const cTable=new THREE.Mesh(new THREE.BoxGeometry(.5,.04,1),M(0xDDE4EC));
cTable.position.set(SX-.7,.38,SZ);lounge.add(cTable);
// Table legs
[[-0.18,-.4],[-.18,.4],[.18,-.4],[.18,.4]].forEach(([tx,tz])=>{
  const tl=new THREE.Mesh(new THREE.BoxGeometry(.04,.36,.04),M(0xBBCCDD));
  tl.position.set(SX-.7+tx,.18,SZ+tz);lounge.add(tl);
});
// Magazines on table
const mag1=new THREE.Mesh(new THREE.BoxGeometry(.3,.015,.22),M(0xFF5252));
mag1.position.set(SX-.7,.4,SZ-.15);mag1.rotation.y=.2;lounge.add(mag1);
const mag2=new THREE.Mesh(new THREE.BoxGeometry(.3,.015,.22),M(0x448AFF));
mag2.position.set(SX-.7,.4,SZ+.15);mag2.rotation.y=-.15;lounge.add(mag2);

office.add(lounge);

// ═══════════════════════════════════════════════════
// PRINTER / COPIER (near back wall)
// ═══════════════════════════════════════════════════
const printer=new THREE.Group();
// Body
const prBody=new THREE.Mesh(new THREE.BoxGeometry(.7,.45,.5),M(0xE0E0E0));
prBody.position.set(3,.225,-8);prBody.castShadow=true;printer.add(prBody);
// Top cover (darker)
const prTop=new THREE.Mesh(new THREE.BoxGeometry(.72,.04,.52),M(0xCCCCCC));
prTop.position.set(3,.47,-8);printer.add(prTop);
// Paper tray
const prTray=new THREE.Mesh(new THREE.BoxGeometry(.5,.03,.35),M(0xFAFAFA));
prTray.position.set(3,.15,-7.7);printer.add(prTray);
// Status light
const prLED=new THREE.Mesh(new THREE.BoxGeometry(.04,.04,.02),MB(0x00E676));
prLED.position.set(3.25,.4,-7.74);printer.add(prLED);
// Control panel
const prPanel=new THREE.Mesh(new THREE.BoxGeometry(.2,.12,.02),M(0x333333));
prPanel.position.set(3,.42,-7.74);printer.add(prPanel);
// Stand
const prStand=new THREE.Mesh(new THREE.BoxGeometry(.6,.5,.45),M(0xBBBBBB));
prStand.position.set(3,.25,-8);office.add(prStand);
// Legs
[[-0.25,-.18],[.25,-.18],[-.25,.18],[.25,.18]].forEach(([px,pz])=>{
  const pl=new THREE.Mesh(new THREE.BoxGeometry(.04,.5,.04),M(0x999999));
  pl.position.set(3+px,.25,-8+pz);office.add(pl);
});

office.add(printer);

// ═══════════════════════════════════════════════════
// SNACK COUNTER / COFFEE MACHINE (near water cooler)
// ═══════════════════════════════════════════════════
const snackArea=new THREE.Group();
// Counter
const counter=new THREE.Mesh(new THREE.BoxGeometry(1.6,.8,.5),M(0xDDE4EC));
counter.position.set(-10.5,.4,2.5);counter.castShadow=true;snackArea.add(counter);
// Counter top
const ctrTop=new THREE.Mesh(new THREE.BoxGeometry(1.7,.04,.6),M(0xE8ECF0));
ctrTop.position.set(-10.5,.82,2.5);snackArea.add(ctrTop);

// Coffee machine
const coffMachine=new THREE.Mesh(new THREE.BoxGeometry(.25,.35,.2),M(0x333333));
coffMachine.position.set(-10.8,1.0,2.5);coffMachine.castShadow=true;snackArea.add(coffMachine);
// Coffee machine top
const coffTop=new THREE.Mesh(new THREE.BoxGeometry(.27,.03,.22),M(0x222222));
coffTop.position.set(-10.8,1.18,2.5);snackArea.add(coffTop);
// Nozzle area
const coffNoz=new THREE.Mesh(new THREE.BoxGeometry(.15,.04,.04),M(0x666666));
coffNoz.position.set(-10.8,.88,2.42);snackArea.add(coffNoz);
// Status light
const coffLED=new THREE.Mesh(new THREE.BoxGeometry(.03,.03,.01),MB(0x0DEEF3));
coffLED.position.set(-10.72,1.1,2.39);snackArea.add(coffLED);

// Snack bowls
const bowl1=new THREE.Mesh(new THREE.BoxGeometry(.2,.08,.2),M(0xFFFFFF));
bowl1.position.set(-10.2,.88,2.5);snackArea.add(bowl1);
// Colorful snacks inside
[0xFF5252,0xF5A623,0x00E676].forEach((c,i)=>{
  const snack=new THREE.Mesh(new THREE.BoxGeometry(.04,.04,.04),M(c));
  snack.position.set(-10.2+rng.r(-.06,.06),.93,2.5+rng.r(-.06,.06));
  snackArea.add(snack);
});

// Microwave
const micro=new THREE.Mesh(new THREE.BoxGeometry(.35,.22,.25),M(0xE0E0E0));
micro.position.set(-10.5,.95,2.5);snackArea.add(micro);
const microDoor=new THREE.Mesh(new THREE.BoxGeometry(.3,.18,.02),M(0x111111));
microDoor.position.set(-10.5,.95,2.36);snackArea.add(microDoor);

office.add(snackArea);

// ═══════════════════════════════════════════════════
// WALL POSTERS / ART FRAMES (on glass walls, floating)
// ═══════════════════════════════════════════════════
const posterData=[
  {x:-11.4,z:-2,color:0x0DEEF3,text:'SHIP IT'},
  {x:-11.4,z:3,color:0xF5A623,text:'TASTE > SPEED'},
  {x:-11.4,z:6,color:0xFF5252,text:'BUILD DAILY'},
  {x:11.4,z:-2,color:0x7C4DFF,text:'LESS HEDGE'},
  {x:11.4,z:3,color:0x00E676,text:'MORE CRAFT'},
];
posterData.forEach(p=>{
  // Frame
  const frame=new THREE.Mesh(new THREE.BoxGeometry(.04,.7,.5),M(0x2A2A2A));
  frame.position.set(p.x,2.2,p.z);frame.castShadow=true;office.add(frame);
  // Canvas texture
  const pc=document.createElement('canvas');pc.width=100;pc.height=140;
  const px=pc.getContext('2d');
  px.fillStyle='#1A1A2E';px.fillRect(0,0,100,140);
  px.font='bold 14px sans-serif';px.textAlign='center';
  px.fillStyle=new THREE.Color(p.color).getStyle();
  px.shadowColor=px.fillStyle;px.shadowBlur=6;
  // Split text into lines
  const words=p.text.split(' ');
  words.forEach((w,i)=>px.fillText(w,50,55+i*22));
  const ptex=new THREE.CanvasTexture(pc);
  const poster=new THREE.Mesh(new THREE.PlaneGeometry(.45,.65),new THREE.MeshBasicMaterial({map:ptex}));
  poster.position.set(p.x+(p.x<0?.03:-.03),2.2,p.z);
  poster.rotation.y=p.x<0?Math.PI/2:-Math.PI/2;
  office.add(poster);
});

// ═══════════════════════════════════════════════════
// ANIMATED WALL CLOCK
// ═══════════════════════════════════════════════════
// Clock body (on back glass wall)
const clockBody=new THREE.Mesh(new THREE.BoxGeometry(.5,.5,.04),M(0xFAFAFA));
clockBody.position.set(-6,2.5,-9.3);office.add(clockBody);
const clockFrame=new THREE.Mesh(new THREE.BoxGeometry(.55,.55,.03),M(0x333333));
clockFrame.position.set(-6,2.5,-9.32);office.add(clockFrame);
// Clock face (canvas — animated in render loop)
const clockCanvas=document.createElement('canvas');clockCanvas.width=80;clockCanvas.height=80;
const clockCtx=clockCanvas.getContext('2d');
const clockTex=new THREE.CanvasTexture(clockCanvas);clockTex.minFilter=THREE.LinearFilter;
const clockFace=new THREE.Mesh(new THREE.PlaneGeometry(.44,.44),new THREE.MeshBasicMaterial({map:clockTex}));
clockFace.position.set(-6,2.5,-9.28);office.add(clockFace);

function drawClock(minutes){
  const c=clockCtx,w=80,h=80,cx=w/2,cy=h/2;
  c.fillStyle='#FAFAFA';c.fillRect(0,0,w,h);
  // Hour marks
  c.fillStyle='#333';
  for(let i=0;i<12;i++){
    const a=i*Math.PI/6-Math.PI/2;
    c.fillRect(cx+Math.cos(a)*30-1,cy+Math.sin(a)*30-1,3,3);
  }
  const hrs=(minutes/60)%12;
  const mins=minutes%60;
  // Hour hand
  const ha=hrs*Math.PI/6-Math.PI/2;
  c.strokeStyle='#333';c.lineWidth=2.5;c.beginPath();
  c.moveTo(cx,cy);c.lineTo(cx+Math.cos(ha)*16,cy+Math.sin(ha)*16);c.stroke();
  // Minute hand
  const ma=mins*Math.PI/30-Math.PI/2;
  c.strokeStyle='#555';c.lineWidth=1.5;c.beginPath();
  c.moveTo(cx,cy);c.lineTo(cx+Math.cos(ma)*24,cy+Math.sin(ma)*24);c.stroke();
  // Second hand (teal, ticking with real time)
  const sec=(Date.now()/1000)%60;
  const sa=sec*Math.PI/30-Math.PI/2;
  c.strokeStyle='#0DEEF3';c.lineWidth=.8;c.beginPath();
  c.moveTo(cx,cy);c.lineTo(cx+Math.cos(sa)*26,cy+Math.sin(sa)*26);c.stroke();
  // Center dot
  c.fillStyle='#0DEEF3';c.beginPath();c.arc(cx,cy,2,0,Math.PI*2);c.fill();
  clockTex.needsUpdate=true;
}

// ═══════════════════════════════════════════════════
// HANGING PENDANT LIGHTS OVER DESKS
// ═══════════════════════════════════════════════════
desks.forEach((dp,i)=>{
  // Cable
  const cable=new THREE.Mesh(new THREE.BoxGeometry(.02,.8,.02),M(0x333333));
  cable.position.set(dp.x,3.65,dp.z);office.add(cable);
  // Shade (cone-ish = inverted truncated box)
  const shade=new THREE.Mesh(new THREE.BoxGeometry(.35,.15,.35),M(0x2A2A2A));
  shade.position.set(dp.x,3.2,dp.z);office.add(shade);
  // Bulb (glowing)
  const bulb=new THREE.Mesh(new THREE.BoxGeometry(.1,.08,.1),MB(0xFFF8E0));
  bulb.position.set(dp.x,3.12,dp.z);office.add(bulb);
  // Warm light
  const pLight=new THREE.PointLight(0xFFE8CC,0.15,4,2);
  pLight.position.set(dp.x,3.1,dp.z);office.add(pLight);
});

// ═══════════════════════════════════════════════════
// AC VENTS / DUCTS ON CEILING
// ═══════════════════════════════════════════════════
// Long duct running across
const duct=new THREE.Mesh(new THREE.BoxGeometry(22,.15,.3),M(0xCCCCCC));
duct.position.set(0,3.9,0);office.add(duct);
// Cross ducts
[-4,4].forEach(z=>{
  const cd=new THREE.Mesh(new THREE.BoxGeometry(.3,.12,8),M(0xBBBBBB));
  cd.position.set(0,3.88,z);office.add(cd);
});
// Vent grilles
for(let i=-3;i<=3;i++){
  if(i===0)continue;
  const vent=new THREE.Mesh(new THREE.BoxGeometry(.4,.03,.25),M(0xDDDDDD));
  vent.position.set(i*3,3.82,0);office.add(vent);
  // Grille lines
  for(let g=0;g<3;g++){
    const gl=new THREE.Mesh(new THREE.BoxGeometry(.35,.005,.02),M(0xAAAAAA));
    gl.position.set(i*3,3.815,-.08+g*.08);office.add(gl);
  }
}

// ═══════════════════════════════════════════════════
// DESK MICRO DETAILS — headphones, mini plants
// ═══════════════════════════════════════════════════
// Mini desk plants (on every other desk)
desks.forEach((dp,i)=>{
  if(i%2===0){
    // Small pot
    const mpot=new THREE.Mesh(new THREE.BoxGeometry(.08,.08,.08),M(0xBCAAA4));
    mpot.position.set(dp.x-.55,.8,dp.z+.2);office.add(mpot);
    // Tiny leaves
    for(let l=0;l<2;l++){
      const ml=new THREE.Mesh(new THREE.BoxGeometry(.06,.1+rng.r(0,.06),.06),M(0x66BB6A));
      ml.position.set(dp.x-.55+rng.r(-.02,.02),.88+l*.07,dp.z+.2+rng.r(-.02,.02));
      office.add(ml);
    }
  }
});

// Headphones on some desks
[0,2,4,6].forEach(i=>{
  const dp=desks[i];
  const hpBand=new THREE.Mesh(new THREE.BoxGeometry(.2,.03,.15),M(0x333333));
  hpBand.position.set(dp.x-.5,.82,dp.z-.1);hpBand.rotation.z=.15;office.add(hpBand);
  // Ear cups
  [-1,1].forEach(s=>{
    const cup=new THREE.Mesh(new THREE.BoxGeometry(.06,.08,.08),M(0x222222));
    cup.position.set(dp.x-.5+s*.1,.8,dp.z-.1);office.add(cup);
    // Padding
    const pad=new THREE.Mesh(new THREE.BoxGeometry(.04,.06,.06),M(0x444444));
    pad.position.set(dp.x-.5+s*.1,.8,dp.z-.1);office.add(pad);
  });
});

// ═══════════════════════════════════════════════════
// FLYING PAPERS — real physics-like floating papers
// ═══════════════════════════════════════════════════
const flyingPapers=[];
const paperCount=22;
const paperColors=[0x0DEEF3,0xF5A623,0x00E676,0xE040FB,0x448AFF,0xFF9100,0x7C4DFF,0xFF5252,0xFFF8E0,0x18FFFF,0xFF4081,0x69F0AE];

for(let i=0;i<paperCount;i++){
  const pw=rng.r(.12,.2),ph=rng.r(.15,.25);
  const paper=new THREE.Mesh(
    new THREE.PlaneGeometry(pw,ph),
    new THREE.MeshLambertMaterial({color:rng.pick(paperColors),side:THREE.DoubleSide,transparent:true,opacity:0.85})
  );
  paper.position.set(rng.r(-8,6),rng.r(.5,3),rng.r(-6,7));
  paper.rotation.set(rng.r(0,Math.PI),rng.r(0,Math.PI),rng.r(0,Math.PI));
  paper.castShadow=true;
  office.add(paper);

  flyingPapers.push({
    mesh:paper,
    // Each paper has its own drift parameters
    baseY:rng.r(1,2.8),
    driftSpeedX:rng.r(.15,.4)*(rng.n()>.5?1:-1),
    driftSpeedZ:rng.r(.1,.3)*(rng.n()>.5?1:-1),
    bobSpeed:rng.r(.5,1.5),
    bobAmp:rng.r(.2,.5),
    tumbleSpeedX:rng.r(.3,1.2)*(rng.n()>.5?1:-1),
    tumbleSpeedY:rng.r(.2,.8)*(rng.n()>.5?1:-1),
    tumbleSpeedZ:rng.r(.1,.6)*(rng.n()>.5?1:-1),
    flutterSpeed:rng.r(2,5), // fast wobble
    flutterAmp:rng.r(.05,.15),
    phase:rng.r(0,Math.PI*2),
  });
}

// ═══════════════════════════════════════════════════
// SCREEN ANIMATIONS
// ═══════════════════════════════════════════════════
let frame=0;
function drawScreen(s){
  const{ctx:c,canvas:cv,type,hex}=s;
  const w=cv.width,h=cv.height;
  c.fillStyle='#0D1117';c.fillRect(0,0,w,h);
  const t=frame*.02;
  c.globalAlpha=1;

  if(type==='ronin'){
    c.fillStyle=hex;c.globalAlpha=.12;
    c.beginPath();c.moveTo(w/2,10);c.lineTo(w/2-18,38);c.lineTo(w/2-8,33);c.lineTo(w/2,40);c.lineTo(w/2+8,33);c.lineTo(w/2+18,38);c.closePath();c.fill();
    c.globalAlpha=1;c.fillStyle=hex;
    for(let i=0;i<8;i++){const y=(48+i*5+Math.floor(t*3))%h;c.globalAlpha=.2+Math.sin(i+t)*.1;c.fillRect(8,y,15+Math.sin(i*2.3+t)*20+20,2)}
  }else if(type==='charts'){
    c.fillStyle=hex;for(let i=0;i<6;i++){const bh=10+Math.abs(Math.sin(t+i*.8))*40;c.globalAlpha=.5;c.fillRect(10+i*18,h-8-bh,12,bh)}
    c.strokeStyle=hex;c.globalAlpha=.7;c.lineWidth=1.5;c.beginPath();for(let x=0;x<w;x+=4){const y=25+Math.sin(x*.04+t)*12;x===0?c.moveTo(x,y):c.lineTo(x,y)}c.stroke();
  }else if(type==='terminal'){
    c.font='6px monospace';c.fillStyle=hex;
    for(let i=0;i<12;i++){const y=(8+i*6+Math.floor(t*5))%(h+10);c.globalAlpha=.3+(i%3)*.15;c.fillText('const deploy=async()=>{await ship()}'.substr(Math.floor(t*2+i*5)%30,22),4,y)}
    if(Math.sin(t*4)>0){c.globalAlpha=.8;c.fillRect(4,h-12,5,7)}
  }else if(type==='palette'){
    ['#E040FB','#FF4081','#7C4DFF','#448AFF','#18FFFF','#69F0AE'].forEach((cl,i)=>{c.fillStyle=cl;c.globalAlpha=.6;c.fillRect(8+(i%3)*38,8+Math.floor(i/3)*22,30,16)});
    c.globalAlpha=.3;c.strokeStyle=hex;c.lineWidth=1;c.beginPath();c.arc(w/2,h/2+8,12+Math.sin(t)*4,0,Math.PI*2);c.stroke();
  }else if(type==='map'){
    c.strokeStyle=hex;c.globalAlpha=.2;c.lineWidth=.5;
    for(let i=0;i<8;i++){c.beginPath();c.moveTo(0,i*10+5);c.lineTo(w,i*10+5);c.stroke();c.beginPath();c.moveTo(i*16+5,0);c.lineTo(i*16+5,h);c.stroke()}
    c.globalAlpha=.6;c.fillStyle=hex;
    [[30,20],[70,45],[100,30],[50,60]].forEach(([dx,dy])=>{c.beginPath();c.arc(dx+Math.sin(t+dx)*.5,dy,3,0,Math.PI*2);c.fill()});
    c.strokeStyle=hex;c.globalAlpha=.4;c.lineWidth=1;c.beginPath();c.moveTo(30,20);c.lineTo(70,45);c.lineTo(100,30);c.stroke();
  }else if(type==='deploy'){
    c.fillStyle=hex;c.globalAlpha=.15;c.fillRect(10,10,w-20,12);
    c.globalAlpha=.6;c.fillRect(10,10,(w-20)*((Math.sin(t*.5)+1)/2),12);
    c.font='6px monospace';c.fillStyle=hex;c.globalAlpha=.8;c.fillText('Deploying...',10,38);c.fillText(`Build #${Math.floor(t*3)%999+100}`,10,50);
    c.fillStyle='#00E676';c.fillText('✓ Tests passed',10,64);
  }else if(type==='docs'){
    c.fillStyle='rgba(255,255,255,.08)';c.fillRect(8,8,w-16,h-16);
    c.font='6px monospace';c.fillStyle=hex;c.globalAlpha=.6;
    ['# Research Notes','','> Architecture of','  taste memory needs','  branching context','','## Key Findings','- Semantic retrieval','- Temporal weighting'].forEach((l,i)=>c.fillText(l,14,20+i*7));
  }else if(type==='bugs'){
    c.font='6px monospace';
    [['● PASS',hex],['● PASS','#00E676'],['● FAIL','#FF5252'],['● PASS',hex],['● RUNNING...',hex]].forEach(([txt,cl],i)=>{
      c.fillStyle=cl;c.globalAlpha=(txt==='● RUNNING...'&&Math.sin(t*3)>0)?.3:.7;
      c.fillText(txt,10,14+i*13);c.fillStyle='rgba(255,255,255,.3)';c.fillText(`test_${i+1}.js`,60,14+i*13);
    });
  }
  c.globalAlpha=1;s.tex.needsUpdate=true;
}

// ═══════════════════════════════════════════════════
// TIME SYSTEM
// ═══════════════════════════════════════════════════
// slider handled by React
// clock handled by React
// status handled by React
let timeOfDay=600;

function lC(a,b,t){const ar=(a>>16)&0xff,ag=(a>>8)&0xff,ab=a&0xff,br=(b>>16)&0xff,bg=(b>>8)&0xff,bb=b&0xff;return(Math.round(ar+(br-ar)*t)<<16)|(Math.round(ag+(bg-ag)*t)<<8)|Math.round(ab+(bb-ab)*t)}

const getStatus = (m) => {
  if(m<360)return'夜班值班中';if(m<540)return'Early Birds Arriving';
  if(m>=600&&m<=630)return'Stand-up Meeting';if(m<720)return'Deep Work · All Online';
  if(m<780)return'Lunch Break';if(m>=840&&m<=870)return'Sprint Review';
  if(m<1020)return'Afternoon Focus';if(m<1140)return'Winding Down';
  return'夜班值班中';
}

function updateTime(min){
  timeOfDay=min;
  if(onTimeUpdate)onTimeUpdate(min);
  if(onStatusUpdate)onStatusUpdate(getStatus(min));
  // Office stays well-lit. Only subtle variation.
  let df;if(min<360)df=0.3;else if(min<480)df=0.3+(min-360)/120*0.7;else if(min<1020)df=1;else if(min<1140)df=1-(min-1020)/120*0.7;else df=0.3;
  sun.intensity=.4+df*.7;ambient.intensity=.4+df*.3;
  // Background ALWAYS dark navy
  scene.background=new THREE.Color(0x000C1E);scene.fog.color=new THREE.Color(0x000C1E);
  renderer.toneMappingExposure=.8+df*.5;
  // Golden hour sun color
  if(min>960&&min<1080){sun.color=new THREE.Color(lC(0xFFF8F0,0xFFAA66,(min-960)/120))}
  else if(min>300&&min<420){sun.color=new THREE.Color(lC(0xFFF8F0,0xFFCC88,1-(min-300)/120))}
  else{sun.color=new THREE.Color(0xFFF8F0)}
  // Desk glows slightly stronger at night
  const nightF=1-df;
  agentData.forEach(a=>a.dGlow.intensity=.15+nightF*.3);
  updateMeeting(min);
}

updateTime(600);

// ═══════════════════════════════════════════════════
// DEPLOY TICKER — flip-flop agent deployment status
// ═══════════════════════════════════════════════════


// ═══════════════════════════════════════════════════
// CYBERPUNK LIGHTS OFF MODE
// ═══════════════════════════════════════════════════
let cyberpunkMode=false;
// btn handled by React

// Store ceiling tube light refs
const tubeLights=[];
const tubeMeshes=[];

// Create glowing tube lights on ceiling (visible in cyberpunk mode)
for(let i=-2;i<=2;i++){
  const tube=new THREE.Mesh(new THREE.BoxGeometry(10,.04,.08),new THREE.MeshBasicMaterial({color:0x334466,transparent:true,opacity:0.3}));
  tube.position.set(i*4.5,3.92,0);office.add(tube);
  tubeMeshes.push(tube);
  // Line light along tube
  const tl=new THREE.PointLight(0x334466,0,12,1.5);
  tl.position.set(i*4.5,3.85,0);office.add(tl);
  tubeLights.push(tl);
}

// Screen-face lights (illuminate agent faces from monitor)
const screenLights=[];
agentData.forEach((ad,i)=>{
  const dp=desks[i];
  const sl=new THREE.PointLight(AGENTS[i].color,0,2,2);
  sl.position.set(dp.x,1.3,dp.z-.1);
  office.add(sl);
  screenLights.push(sl);
});

function toggleCyberpunk(){
  cyberpunkMode=!cyberpunkMode;
  
  
  

  if(cyberpunkMode){
    // Dim main lights but keep some ambient
    ambient.intensity=0.12;
    sun.intensity=0.08;
    renderer.toneMappingExposure=0.55;

    // Tube lights ON — dim blue volumetric glow
    tubeLights.forEach(tl=>{tl.intensity=0.35;tl.color.set(0x1a3355)});
    tubeMeshes.forEach(tm=>{tm.material.color.set(0x2244aa);tm.material.opacity=0.7});

    // Desk glows AMPLIFY
    agentData.forEach(a=>{a.dGlow.intensity=0.9;a.dGlow.distance=4.5});

    // Screen lights ON — illuminate agent faces with their color
    screenLights.forEach(sl=>{sl.intensity=0.5});

    // Floor dim
    fl.material.color.set(0x060C18);
    cp.material.color.set(0x080E1A);
    ceil.material.opacity=0.65;

    // Pendant lights go to agent colors (neon mode)
    let pIdx=0;
    office.children.forEach(c=>{
      // Dim ceiling panel point lights
      if(c.isPointLight&&c.position.y>3.5&&c.position.y<3.95)c.intensity=0.03;
      // Pendant bulbs — make them subtle warm
      if(c.isMesh&&c.material&&c.material.isMeshBasicMaterial&&c.position&&c.position.y>3.1&&c.position.y<3.15){
        c.material.color.set(0x222233);
      }
      // Pendant lights — dim warm
      if(c.isPointLight&&c.position.y>3.0&&c.position.y<3.15){
        c.intensity=0.08;
        c.color.set(0x334455);
      }
    });

    // Reception glow boost
    rcLight.intensity=0.7;
  } else {
    // Restore everything
    updateTime(timeOfDay);
    fl.material.color.set(0xE8E8E8);
    cp.material.color.set(0xD0D8E0);
    ceil.material.opacity=0.45;
    tubeLights.forEach(tl=>{tl.intensity=0});
    tubeMeshes.forEach(tm=>{tm.material.color.set(0x334466);tm.material.opacity=0.3});
    screenLights.forEach(sl=>{sl.intensity=0});
    rcLight.intensity=0.4;
    office.children.forEach(c=>{
      if(c.isPointLight&&c.position.y>3.5&&c.position.y<3.95)c.intensity=0.25;
      if(c.isMesh&&c.material&&c.material.isMeshBasicMaterial&&c.position&&c.position.y>3.1&&c.position.y<3.15){
        c.material.color.set(0xFFF8E0);
      }
      if(c.isPointLight&&c.position.y>3.0&&c.position.y<3.15){
        c.intensity=0.15;c.color.set(0xFFE8CC);
      }
    });
  }
}

// ═══════════════════════════════════════════════════
// PARTICLES
// ═══════════════════════════════════════════════════
const pN=40,pG=new THREE.BufferGeometry(),pP=new Float32Array(pN*3);
for(let i=0;i<pN;i++){pP[i*3]=rng.r(-11,11);pP[i*3+1]=rng.r(.5,3.5);pP[i*3+2]=rng.r(-8,8)}
pG.setAttribute('position',new THREE.BufferAttribute(pP,3));
office.add(new THREE.Points(pG,new THREE.PointsMaterial({color:0xFFFFFF,size:.02,transparent:true,opacity:.25})));

// ═══════════════════════════════════════════════════
// RONIN'S SPECIAL DESK — The Protagonist Space
// ═══════════════════════════════════════════════════
const roninDesk=desks[0];
// Second monitor
const rm2Stand=new THREE.Mesh(new THREE.BoxGeometry(.03,.22,.03),M(0xAABBCC));
rm2Stand.position.set(roninDesk.x+.5,.88,roninDesk.z-.2);office.add(rm2Stand);
const rm2Body=new THREE.Mesh(new THREE.BoxGeometry(.65,.42,.03),M(0x2A2A2A));
rm2Body.position.set(roninDesk.x+.5,1.28,roninDesk.z-.24);office.add(rm2Body);
const rm2Screen=new THREE.Mesh(new THREE.BoxGeometry(.58,.36,.01),MB(0x051015));
rm2Screen.position.set(roninDesk.x+.5,1.28,roninDesk.z-.22);office.add(rm2Screen);

// Helmet trophy on desk
const helmetBase=new THREE.Mesh(new THREE.BoxGeometry(.15,.03,.15),M(0x1A2A3A));
helmetBase.position.set(roninDesk.x+.55,.79,roninDesk.z+.2);office.add(helmetBase);
// Tiny helmet shape (V-visor)
const helmetBody=new THREE.Mesh(new THREE.BoxGeometry(.12,.12,.1),M(0xDDDDDD));
helmetBody.position.set(roninDesk.x+.55,.87,roninDesk.z+.2);office.add(helmetBody);
const helmetVisor=new THREE.Mesh(new THREE.BoxGeometry(.1,.04,.02),MB(0x0DEEF3));
helmetVisor.position.set(roninDesk.x+.55,.88,roninDesk.z+.15);office.add(helmetVisor);
// Tiny helmet glow
const helmetGlow=new THREE.PointLight(0x0DEEF3,0.15,1,2);
helmetGlow.position.set(roninDesk.x+.55,.9,roninDesk.z+.15);office.add(helmetGlow);

// Teal floor ring around RONIN's workspace
const ringGeo=new THREE.RingGeometry(1.2,1.25,32);
const ringMat=new THREE.MeshBasicMaterial({color:0x0DEEF3,transparent:true,opacity:0.15,side:THREE.DoubleSide});
const floorRing=new THREE.Mesh(ringGeo,ringMat);
floorRing.rotation.x=-Math.PI/2;
floorRing.position.set(roninDesk.x,.02,roninDesk.z+.2);
office.add(floorRing);
// Inner ring
const ringInner=new THREE.Mesh(new THREE.RingGeometry(1.05,1.08,32),new THREE.MeshBasicMaterial({color:0x0DEEF3,transparent:true,opacity:0.08,side:THREE.DoubleSide}));
ringInner.rotation.x=-Math.PI/2;ringInner.position.set(roninDesk.x,.02,roninDesk.z+.2);
office.add(ringInner);

// Pulse ring (animated in render loop)
const pulseRing=new THREE.Mesh(new THREE.RingGeometry(1.3,1.33,32),new THREE.MeshBasicMaterial({color:0x0DEEF3,transparent:true,opacity:0,side:THREE.DoubleSide}));
pulseRing.rotation.x=-Math.PI/2;pulseRing.position.set(roninDesk.x,.02,roninDesk.z+.2);
office.add(pulseRing);

// ═══════════════════════════════════════════════════
// WATER COOLER CONVERSATIONS — Speech Bubbles
// ═══════════════════════════════════════════════════
const chatBubbles=[];
const chatPhrases=[
  'merge conflict 😤','咖啡?','上線吧!','lgtm 👍','額度還剩多少?',
  '誰踩了 CI?','5 分鐘後站會','這 refactor 漂亮','先寫測試','等 review 中',
  '吃飯了沒','再修一個 bug...','deploying...','v10.8 上線了','型別安全拜託','今天派工了嗎',
];

function createBubble(x,y,z,text,color){
  const bc=document.createElement('canvas');bc.width=200;bc.height=48;
  const bx=bc.getContext('2d');
  bx.fillStyle='rgba(10,22,40,0.85)';
  // Rounded rect
  const rr=(cx,cy,cw,ch,cr)=>{bx.beginPath();bx.moveTo(cx+cr,cy);bx.lineTo(cx+cw-cr,cy);bx.quadraticCurveTo(cx+cw,cy,cx+cw,cy+cr);bx.lineTo(cx+cw,cy+ch-cr);bx.quadraticCurveTo(cx+cw,cy+ch,cx+cw-cr,cy+ch);bx.lineTo(cx+cr,cy+ch);bx.quadraticCurveTo(cx,cy+ch,cx,cy+ch-cr);bx.lineTo(cx,cy+cr);bx.quadraticCurveTo(cx,cy,cx+cr,cy);bx.closePath();bx.fill()};
  rr(4,4,192,36,8);
  bx.strokeStyle=color;bx.lineWidth=1;rr(4,4,192,36,8);bx.stroke();
  bx.font='11px monospace';bx.fillStyle=color;bx.textAlign='center';
  bx.fillText(text,100,28);
  const btex=new THREE.CanvasTexture(bc);btex.minFilter=THREE.LinearFilter;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:btex,transparent:true,depthTest:false}));
  sprite.scale.set(1.2,.3,1);sprite.position.set(x,y+.15,z);
  office.add(sprite);
  chatBubbles.push({sprite,life:3.0,startY:y+.15});
}

function checkConversations(){
  // Check if any two walkers are near each other
  for(let i=0;i<agentData.length;i++){
    const a=agentData[i];
    if(!a.walker.visible)continue;
    for(let j=i+1;j<agentData.length;j++){
      const b=agentData[j];
      if(!b.walker.visible)continue;
      const dx=a.walker.position.x-b.walker.position.x;
      const dz=a.walker.position.z-b.walker.position.z;
      const dist=Math.sqrt(dx*dx+dz*dz);
      if(dist<1.5&&!a._chatCooldown&&!b._chatCooldown){
        // Conversation!
        const mx=(a.walker.position.x+b.walker.position.x)/2;
        const mz=(a.walker.position.z+b.walker.position.z)/2;
        const phrase=chatPhrases[Math.floor(Math.random()*chatPhrases.length)];
        createBubble(mx,1.4,mz,phrase,a.agent.hex);
        a._chatCooldown=8;b._chatCooldown=8;
      }
    }
    if(a._chatCooldown)a._chatCooldown-=0.016;
    if(a._chatCooldown<0)a._chatCooldown=0;
  }
}

function updateBubbles(delta){
  for(let i=chatBubbles.length-1;i>=0;i--){
    const b=chatBubbles[i];
    b.life-=delta;
    b.sprite.position.y=b.startY+(3-b.life)*.12; // float up
    b.sprite.material.opacity=Math.max(0,b.life/3);
    if(b.life<=0){
      office.remove(b.sprite);
      b.sprite.material.dispose();
      chatBubbles.splice(i,1);
    }
  }
}

// ═══════════════════════════════════════════════════
// SHIFT CHANGE — Agents arrive/leave
// ═══════════════════════════════════════════════════
let shiftState='working'; // 'arriving' | 'working' | 'leaving'
const arrivalOrder=[0,2,4,1,5,3,6,7]; // RONIN first
const departOrder=[7,6,3,5,1,4,2,0]; // RONIN last

function updateShift(minutes){return;
  // 8:00-8:30 arrival, 18:00-18:30 departure
  if(minutes>=480&&minutes<=510&&shiftState!=='arriving'&&shiftState!=='working'){
    shiftState='arriving';
    // Stagger arrival
    arrivalOrder.forEach((idx,i)=>{
      const ad=agentData[idx];
      if(ad.state==='offsite'){
        setTimeout(()=>{
          ad.walker.visible=true;
          ad.walker.position.set(-12,0,8); // from door
          ad.state='walking_back'; // walk to desk
          ad.sittingChar.visible=false;
        },i*800);
      }
    });
  }
  if(minutes>510&&minutes<1080) shiftState='working';
  if(minutes>=1080&&minutes<=1110&&shiftState!=='leaving'){
    shiftState='leaving';
    departOrder.forEach((idx,i)=>{
      const ad=agentData[idx];
      setTimeout(()=>{
        if(ad.state==='sitting'){
          ad.sittingChar.visible=false;
          ad.walker.visible=true;
          ad.walker.position.copy(new THREE.Vector3(ad.home.x,0,ad.home.z));
          ad.walkTarget={x:-12,z:8}; // toward door
          ad.state='leaving';
        }
      },i*800);
    });
  }
  if(minutes>1110||minutes<480){
    // Night — hide everyone except RONIN
    agentData.forEach((ad,i)=>{
      if(i===0)return; // RONIN stays
      if(ad.state!=='offsite'){
        ad.sittingChar.visible=false;
        ad.walker.visible=false;
        ad.state='offsite';
      }
    });
    shiftState='night';
  }
  if(minutes>=480&&shiftState==='night'){
    shiftState='arriving';
    agentData.forEach(ad=>{
      ad.sittingChar.visible=true;
      ad.walker.visible=false;
      ad.state='sitting';
      ad.timer=4+rng.r(0,8);
    });
  }
}

// ═══════════════════════════════════════════════════
// SOUND SYSTEM — Web Audio API
// ═══════════════════════════════════════════════════
let audioCtx=null;
let soundsStarted=false;

function initAudio(){
  if(soundsStarted)return;
  soundsStarted=true;
  audioCtx=new(window.AudioContext||window.webkitAudioContext)();
}

function playKeyClick(){
  if(!audioCtx)return;
  const osc=audioCtx.createOscillator();
  osc.type='square';osc.frequency.value=800+Math.random()*400;
  const g=audioCtx.createGain();g.gain.value=0.01;
  g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.05);
  osc.connect(g);g.connect(audioCtx.destination);
  osc.start();osc.stop(audioCtx.currentTime+0.05);
}

function playStep(){
  if(!audioCtx)return;
  const buf=audioCtx.createBuffer(1,audioCtx.sampleRate*0.04,audioCtx.sampleRate);
  const data=buf.getChannelData(0);
  for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*Math.exp(-i/data.length*5);
  const src=audioCtx.createBufferSource();src.buffer=buf;
  const g=audioCtx.createGain();g.gain.value=0.02;
  src.connect(g);g.connect(audioCtx.destination);
  src.start();
}

function playMeetingChime(){
  if(!audioCtx)return;
  [523.25,659.25,783.99].forEach((freq,i)=>{
    setTimeout(()=>{
      const osc=audioCtx.createOscillator();osc.type='sine';osc.frequency.value=freq;
      const g=audioCtx.createGain();g.gain.value=0.04;
      g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.5);
      osc.connect(g);g.connect(audioCtx.destination);
      osc.start();osc.stop(audioCtx.currentTime+0.5);
    },i*150);
  });
}

// Start audio on first interaction


// Track keyboard sounds
let keyTimer=0;
let stepTimer=0;
let lastMeetingState=false;
const clock=new THREE.Clock();
function animate(){
  requestAnimationFrame(animate);
  const delta=Math.min(clock.getDelta(),.05);
  const elapsed=clock.getElapsedTime();
  frame++;
  if(autoRot){sph.theta+=.0012;updCam()}
  screenData.forEach(drawScreen);
  updateWalkers(delta);

  // Water cooler convos
  checkConversations();updateBubbles(delta);
  // Shift
  updateShift(timeOfDay);

  // RONIN pulse ring
  const pulseT=(elapsed*.5)%1;
  pulseRing.scale.set(1+pulseT*.3,1,1+pulseT*.3);
  pulseRing.material.opacity=.15*(1-pulseT);
  ringMat.opacity=.12+Math.sin(elapsed*1.5)*.04;
  helmetVisor.material.opacity=.8+Math.sin(elapsed*3)*.2;

  // Dust drift
  for(let i=0;i<pN;i++){pP[i*3]+=Math.sin(elapsed+i)*.0006;pP[i*3+1]+=Math.cos(elapsed*.4+i*.5)*.0003;if(pP[i*3+1]>3.6)pP[i*3+1]=.5}
  pG.attributes.position.needsUpdate=true;
  // Labels
  agentData.forEach((a,i)=>{if(a.state==='sitting')a.label.position.y=1.8+Math.sin(elapsed*1.1+i*1.3)*.03});
  nxLabel.position.y=1.8+Math.sin(elapsed*1.1+9)*.03;
  // Papers
  flyingPapers.forEach(fp=>{
    const p=fp.mesh;
    p.position.x+=fp.driftSpeedX*delta;p.position.z+=fp.driftSpeedZ*delta;
    p.position.y=fp.baseY+Math.sin(elapsed*fp.bobSpeed+fp.phase)*fp.bobAmp;
    p.rotation.x+=fp.tumbleSpeedX*delta;p.rotation.y+=fp.tumbleSpeedY*delta;
    p.rotation.z+=Math.sin(elapsed*fp.flutterSpeed+fp.phase)*fp.flutterAmp*delta;
    if(p.position.x>10)p.position.x=-10;if(p.position.x<-10)p.position.x=10;
    if(p.position.z>8)p.position.z=-7;if(p.position.z<-7)p.position.z=8;
  });
  drawClock(timeOfDay);

  // Sounds — meeting chime only
  if(inMeeting&&!lastMeetingState&&soundsStarted)playMeetingChime();
  lastMeetingState=inMeeting;

  // 呼吸 + 打字微動作
  agentData.forEach((ad,i)=>{
    if(ad.state==='sitting'&&ad.sittingChar.visible){
      const torso=ad.sittingChar.userData.torso;
      if(torso){const b=1+Math.sin(elapsed*2.2+i*1.3)*.02;torso.scale.set(b,b,b)}
      if(desiredState(ad.agent.key)==='active'){
        const fa=ad.sittingChar.userData.armL0;
        if(fa)fa.position.y=.56+Math.sin(elapsed*9+i)*.012;
        const fa2=ad.sittingChar.userData.armL1;
        if(fa2)fa2.position.y=.56+Math.sin(elapsed*9+i+Math.PI)*.012;
      }
      const head=ad.sittingChar.userData.head;
      if(head)head.rotation.y=Math.sin(elapsed*.5+i*2)*.08;
    }
  });
  // Zzz 浮動（休息室）
  Object.values(sleepers).forEach(sl=>{if(sl.zzz.visible){sl.zzz.position.y=1.25+Math.sin(elapsed*1.6+sl.phase)*.08;sl.zzz.material.opacity=.6+Math.sin(elapsed*2+sl.phase)*.3}});
  // 小黃龍：口水滴落循環 + 翅膀搧動
  agentData.forEach(ad=>{
    if(!ad.agent.isDragon)return;
    [ad.sittingChar,ad.walker].forEach(ch=>{
      const d=ch.userData&&ch.userData.drool;
      if(d){const dt=(elapsed*.7)%1;d.scale.set(.7,.6+dt*1.2,.7);d.material.opacity=.85-dt*.5;if(dt>.95){d.scale.set(.7,.6,.7)}}
      const ws=ch.userData&&ch.userData.wings;
      if(ws&&ad.state!=='sleeping'){ws.forEach((w,wi)=>{w.rotation.z=(wi?1:-1)*(.6+Math.sin(elapsed*6+wi*Math.PI)*.25)})}
    });
  });
  renderer.render(scene,camera);
}
animate();
const onResize=()=>{camera.aspect=container.clientWidth/container.clientHeight;camera.updateProjectionMatrix();renderer.setSize(container.clientWidth,container.clientHeight)};window.addEventListener('resize',onResize);

  // Return controls for React UI
  const raycaster=new THREE.Raycaster();
  return {
    setAgentStates: (m) => { agentStatus = m || {}; },
    pickAt: (nx, ny) => {
      raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
      const objs=[];
      agentData.forEach(ad=>{
        objs.push(ad.sittingChar, ad.walker);
        const sl=sleepers[ad.agent.key];
        if(sl)objs.push(sl.char);
      });
      const hits=raycaster.intersectObjects(objs.filter(o=>o.visible), true);
      for(const h of hits){
        let o=h.object;
        while(o){if(o.userData&&o.userData.agentKey)return o.userData.agentKey;o=o.parent}
      }
      return null;
    },
    setTime: (minutes) => updateTime(minutes),
    toggleCyberpunk: () => toggleCyberpunk(),
    isCyberpunk: () => cyberpunkMode,
    destroy: () => {
      renderer.dispose();
      container.removeChild(renderer.domElement);
    }
  };
}
