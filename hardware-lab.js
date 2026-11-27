/* Shared physical hardware view. Geometry is illustrative, not vendor CAD.
   No performance or deployment state is modified by inspection animations. */
(function () {
'use strict';
const T=window.THREE,S=window.__SIM__;
if(!T||!S)return;
const INFO={
 GPU:['GPU 加速模块','执行 Prefill / Decode 中的张量计算。板卡、散热器和封装用于解释结构，具体 GPU 型号与计算性能尚未校准。'],
 HBM:['HBM 显存','位于 GPU 封装附近，保存活跃 KV 与计算数据。图中放大显示封装层次，不代表可单独抽出的内存条。'],
 CPU:['CPU 与主板','执行主机控制、内存管理及数据搬运协调。CXL Host 连接关系必须按具体服务器检查。'],
 DRAM:['DRAM 内存阵列','服务器本地主存，用于缓存或承接 KV 数据。此处以 DIMM 插槽与内存条表达物理结构。'],
 NIC:['RDMA NIC','连接本机 ToR；跨机架请求经 Leaf–Spine 网络访问远端资源。网卡与 CXL 内存接口是不同的数据路径。'],
 CXL:['CXL Host 接口','仅已建立连接的主机可直接访问对应 MHD。未接入主机不能因同机架存在 MHD 自动获得本地 CXL 命中。'],
 FAN:['散热与供电','前部风扇形成贯穿机箱的风道，后部为冗余电源。热设计与功耗暂不参与性能模型。'],
 CTRL:['MHD 多主机控制器','为多个 Host 接口提供内存访问管理。共享映射与一致性能力取决于设备及软件协议，不假设任意主机天然缓存一致。'],
 MEMORY:['MHD 内存模组','共享内存容量读取当前实验配置。副本、迁移和容量管理由上层实验状态维护，硬件查看不会产生性能收益。'],
 TOR:['ToR / Leaf 交换机','连接四台服务器的 RDMA NIC，并上联 Spine。蓝色线缆表示物理连接，不表示正在传输数据。'],
 SPINE:['Spine 交换机','连接各机架的 ToR，构成 Leaf–Spine 网络。图中使用两台逻辑 Spine 表示冗余上联。'],
 POOL:['RDMA 远端内存池','存量架构中的远端存储资源；保留原有 RDMA 网络访问能力。此模型表示逻辑资源，并非额外新增 CXL 硬件。']
};
function topology(){return S.D.RACKS.map(r=>({id:r.id,nodes:r.nodes,units:S.STATE.deployment[r.id]?S.mhdUnitsForRack(r.id):[],links:S.STATE.deployment[r.id]?(S.STATE.cxlLinks[r.id]||[]):[]}));}
window.HARDWARE_MODEL={snapshot:topology};
function View(host,overview){
 this.host=host;this.overview=overview;this.rid='R1';this.expanded=false;this.selected=null;this.key='';this.items=[];this.labels=[];this.targets=[];this.running=false;
 this.scene=new T.Scene();this.scene.background=new T.Color(0x18212b);
 this.camera=new T.PerspectiveCamera(40,1,.01,150);
 this.renderer=new T.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.7));
 this.renderer.outputEncoding=T.sRGBEncoding;this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.8;
 this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFSoftShadowMap;
 host.appendChild(this.renderer.domElement);
 this.controls=new T.OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;this.controls.minDistance=1;this.controls.maxDistance=20;this.controls.maxPolarAngle=Math.PI*.88;
 this.scene.add(new T.HemisphereLight(0xdbe9f7,0x303640,.65));
 const light=new T.DirectionalLight(0xfff3dd,.9);light.position.set(4,8,6);light.castShadow=true;light.shadow.mapSize.set(2048,2048);Object.assign(light.shadow.camera,{left:-7,right:7,top:7,bottom:-7});light.shadow.bias=-.0003;this.scene.add(light);
 const fill=new T.DirectionalLight(0xa9c5df,.4);fill.position.set(-5,4,-4);this.scene.add(fill);
 this.ui=document.createElement('div');this.ui.className='hl-ui';host.appendChild(this.ui);
 this.bar=document.createElement('div');this.bar.className='hl-toolbar';this.ui.appendChild(this.bar);
 this.parts=document.createElement('div');this.parts.className='hl-parts';this.ui.appendChild(this.parts);
 this.card=document.createElement('section');this.card.className='hl-card';this.card.hidden=true;this.ui.appendChild(this.card);
 this.caption=document.createElement('div');this.caption.className='hl-caption';this.ui.appendChild(this.caption);
 this.ray=new T.Raycaster();let down;
 this.renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];this.camTo=null;});
 this.renderer.domElement.addEventListener('wheel',()=>{this.camTo=null;},{passive:true});
 this.renderer.domElement.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;down=null;const b=this.renderer.domElement.getBoundingClientRect();this.ray.setFromCamera(new T.Vector2((e.clientX-b.left)/b.width*2-1,-(e.clientY-b.top)/b.height*2+1),this.camera);const hit=this.ray.intersectObjects(this.targets,false)[0];if(hit&&hit.object.userData.choose)hit.object.userData.choose();});
 this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(host);this.toolbar();this.home();
}
View.prototype.button=function(parent,label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;parent.appendChild(b);return b;};
View.prototype.toolbar=function(){this.bar.replaceChildren();this.button(this.bar,'配置面板',()=>document.getElementById('app').classList.toggle('hl-config-open'));this.button(this.bar,'复位视角',()=>this.home());if(!this.overview){this.button(this.bar,this.expanded?'收拢机柜':'整柜展开',()=>{this.expanded=!this.expanded;this.selected=null;this.parts.replaceChildren();this.card.hidden=true;this.layout();this.home();this.toolbar();});['R1','R2','R3','R4'].forEach(id=>{const b=this.button(this.bar,id,()=>{S.STATE.selectedRack=id;window.__APP__.render();});b.classList.toggle('active',id===this.rid);});}else this.button(this.bar,'查看所选机架',()=>this.jump(this.rid));};
View.prototype.home=function(){this.camTo=this.overview?new T.Vector3(6,5.8,7.5):this.expanded?new T.Vector3(4.4,3.7,6.4):new T.Vector3(2.9,2.2,3.9);this.lookTo=new T.Vector3(0,1.05,0);};
View.prototype.mat=function(c,metal=.3,rough=.6){return new T.MeshStandardMaterial({color:c,metalness:metal,roughness:rough});};
View.prototype.box=function(parent,w,h,d,x,y,z,color,choose){const mesh=new T.Mesh(new T.BoxGeometry(w,h,d),this.mat(color));mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);if(choose){mesh.userData.choose=choose;this.targets.push(mesh);}return mesh;};
View.prototype.badge=function(parent,text,offset,fn){const el=this.button(this.ui,text,fn);el.className='hl-label';this.labels.push({parent,offset:new T.Vector3(...offset),el});};
View.prototype.wire=function(parent,points,color){const c=new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p)));const m=new T.Mesh(new T.TubeGeometry(c,20,.007,5,false),this.mat(color,.1,.8));parent.add(m);return m;};
View.prototype.details=function(title,desc,tag='硬件结构 · 示意模型'){this.card.replaceChildren();this.card.hidden=false;this.button(this.card,'关闭',()=>this.card.hidden=true).className='hl-close';const small=document.createElement('small');small.textContent=tag;const h=document.createElement('h2');h.textContent=title;const p=document.createElement('p');p.textContent=desc;this.card.append(small,h,p);};
View.prototype.info=function(key){const d=INFO[key];if(d)this.details(d[0],d[1]);};
View.prototype.device=function(parent,id,y,kind,nd,unit,rack){
 const g=new T.Group();g.position.set(0,y,0);parent.add(g);const h=kind==='server'?.175:.087;
 const item={id,g,y,kind,nd,unit,rack,parts:[],open:0,target:0,dest:new T.Vector3(0,y,0)};this.items.push(item);
 const choose=()=>this.inspect(item);const dark=0x303942,silver=0x9ba5aa;
 this.box(g,.445,.012,.75,0,-h/2,0,silver,choose);
 [-1,1].forEach(sign=>{this.box(g,.012,h,.75,sign*.225,0,0,silver,choose);this.box(g,.035,h,.025,sign*.244,0,.385,0x171e25,choose);this.box(g,.012,h*.6,.04,sign*.245,0,.415,silver,choose);});
 item.lid=this.box(g,.45,.012,.76,0,h/2,0,0x59636b,choose);
 this.box(g,.44,h,.02,0,0,.38,dark,choose);
 // Recessed drive carriers and ventilation, front faces remain individually selectable.
 for(let i=0;i<8;i++){this.box(g,.043,h*.62,.012,-.179+i*.051,0,.397,0x11171e,choose);this.box(g,.03,.008,.009,-.179+i*.051,-h*.2,.407,0x687781);for(let j=0;j<3;j++)this.box(g,.03,.002,.004,-.179+i*.051,.01+j*.012,.406,0x46525b);}
 this.box(g,.008,.008,.008,.205,.025,.407,0x7bbf9c);
 this.box(g,.41,.008,.66,0,-h*.32,0,0x184c43,choose);
 const part=(key,x,z,w,d,color)=>{const pg=new T.Group();g.add(pg);pg.position.set(x,-h*.15,z);this.box(pg,w,.024,d,0,0,0,color,()=>{if(this.selected!==item)this.inspect(item);this.info(key);});const p={key,g:pg,base:pg.position.clone()};item.parts.push(p);return pg;};
 if(kind==='server'){
  const cpu=part('CPU',-.1,-.18,.07,.07,0x8c969b);for(let i=0;i<8;i++)this.box(cpu,.06,.027,.003,0,.02,-.026+i*.007,0xc0c6c9);
  for(let i=0;i<6;i++){const dimm=part('DRAM',.025+i*.027,-.18,.012,.12,0x397f65);for(let j=0;j<4;j++)this.box(dimm,.014,.012,.018,0,.02,-.043+j*.028,0x151c22);}
  for(let i=0;i<4;i++){const gpu=part('GPU',-.15+i*.1,.04,.075,.15,0x364e48);this.box(gpu,.055,.017,.065,0,.025,0,0xa1a9af);for(let j=0;j<7;j++)this.box(gpu,.052,.02,.003,0,.04,-.026+j*.008,0x7f898e);const hb=part('HBM',-.15+i*.1,.11,.035,.018,0x334d72);hb.userData.package=true;}
  part('NIC',-.12,-.29,.09,.06,0x476e54);this.box(g,.05,.022,.018,-.12,0,-.389,0x9aadb5,()=>this.info('NIC'));
  part('CXL',.12,-.29,.07,.04,0x598b88);this.box(g,.04,.015,.018,.12,0,-.389,0x65a89a,()=>this.info('CXL'));
  for(let i=0;i<4;i++){const fan=part('FAN',-.156+i*.104,.26,.085,.065,0x1d242a);const circle=new T.Mesh(new T.TorusGeometry(.025,.003,6,16),this.mat(0x76838a));circle.rotation.x=Math.PI/2;circle.position.y=.025;fan.add(circle);for(let j=0;j<4;j++){const blade=this.box(fan,.04,.006,.01,0,.026,0,0x4d5a63);blade.rotation.y=j*Math.PI/4;}}
 }else{
  part('CTRL',0,-.18,.09,.09,0x7c8c92);
  for(let i=0;i<8;i++){const mem=part('MEMORY',-.17+i*.049,.03,.018,.26,0x34775e);for(let j=0;j<6;j++)this.box(mem,.022,.014,.027,0,.02,-.1+j*.04,0x151e25);}
  const count=unit.hostInterfaces;for(let i=0;i<count;i++)this.box(g,.035,.02,.014,-.15+i*.09,0,-.389,0x6daca0,()=>this.info('CTRL'));
 }
 if(!this.overview)this.badge(g,id,[.0,.02,.48],choose);
 return item;
};
View.prototype.rack=function(r,index){
 const group=new T.Group();this.root.add(group);if(this.overview)group.position.set((index%2-.5)*2.2,0,(Math.floor(index/2)-.5)*2.6);
 const select=()=>{this.rid=r.id;S.STATE.selectedRack=r.id;if(this.overview){this.details(r.id+' · 42U 机柜',`4 台 GPU 服务器；${r.units.length} 台 MHD。已接入：${r.links.map(l=>l.node).join('、')||'无'}。所有服务器保留 RDMA。`);this.button(this.card,'进入机架解剖',()=>this.jump(r.id));}else {this.expanded=!this.expanded;this.selected=null;this.layout();this.toolbar();this.home();}};
 // 600 mm cabinet / 19-inch mounting rails / nominal 42U height, 1m depth.
 this.box(group,.6,.1,1,0,.05,0,0x252c32,select);this.box(group,.6,.04,1,0,2.04,0,0x363f46,select);
 [-1,1].forEach(x=>[-1,1].forEach(z=>{this.box(group,.035,1.98,.035,x*.282,1.04,z*.47,0x48545c,select);for(let u=0;u<42;u++)this.box(group,.014,.008,.006,x*.253,.145+u*.04445,z*.454,0x10161b);}));
 // Narrow side panels leave the service front open; rear PDU and cable management.
 this.box(group,.008,1.8,.95,-.299,1.05,0,0x303b44,select);this.box(group,.035,1.7,.05,.24,1,-.43,0x20262d,select);
 for(let i=0;i<12;i++)this.box(group,.018,.025,.01,.24,.25+i*.12,-.397,0x68777f);
 const tor=new T.Group();group.add(tor);tor.position.y=1.94;this.box(tor,.45,.044,.4,0,0,0,0x7e8b93,()=>this.info('TOR'));
 for(let i=0;i<16;i++)this.box(tor,.019,.017,.01,-.19+i*.025,0,.207,0x111e26,()=>this.info('TOR'));
 r.nodes.forEach((nd,i)=>{const y=1.64-i*.28;this.device(group,r.id+'-'+nd.id,y,'server',nd,null,r);[-1,1].forEach(sign=>this.box(group,.017,.025,.8,sign*.235,y-.09,0,0x818b92));});
 r.units.forEach((m,i)=>this.device(group,m.id,.24+i*.11,'mhd',null,m,r));
 if(!r.units.length&&!this.overview)this.badge(group,'MHD 预留区 · 未部署',[0,.25,.48],()=>this.details('MHD 预留安装区','当前机架没有 CXL 设备。可在左侧部署配置中添加；查看预留区不会改变实验状态。'));
 this.badge(group,r.id+(r.units.length?' · CXL + RDMA':' · RDMA'),[0,2.2,0],select);
 // Connections attach to actual model endpoints and are rebuilt from shared state.
 const cables=new T.Group();group.add(cables);this.cables.push(cables);
 r.nodes.forEach((nd,i)=>{const y=1.64-i*.28;this.wire(cables,[[-.12,y,-.39],[-.32,y,-.47],[-.32,1.94,-.47],[-.17+i*.1,1.94,-.2]],0x678eae);});
 r.links.forEach((l,i)=>{const ni=r.nodes.findIndex(n=>n.id===l.node),mi=r.units.findIndex(m=>m.id===l.mhdId);if(ni<0||mi<0)return;const y=1.64-ni*.28;this.wire(cables,[[.12,y,-.39],[.35+i*.012,y,-.44],[.35+i*.012,.24+mi*.11,-.44],[-.15+r.links.filter(x=>x.mhdId===l.mhdId).indexOf(l)*.09,.24+mi*.11,-.39]],0x80b9a2);});
 if(this.overview){for(let spine=0;spine<2;spine++){const x=group.position.x,z=group.position.z;this.wire(this.root,[[x,1.94,z-.2],[x,2.5,z-.3],[spine? .6:-.6,2.5,-2.25],[spine?.6:-.6,2.3,-2.25]],0x678eae);}}
};
View.prototype.build=function(){
 if(this.root){this.scene.remove(this.root);const geom=new Set(),mat=new Set();this.root.traverse(o=>{if(o.geometry)geom.add(o.geometry);if(o.material)mat.add(o.material);});geom.forEach(g=>g.dispose());mat.forEach(m=>m.dispose());}
 this.labels.forEach(l=>l.el.remove());this.labels=[];this.items=[];this.targets=[];this.cables=[];this.selected=null;this.parts.replaceChildren();this.card.hidden=true;
 this.root=new T.Group();this.scene.add(this.root);
 this.box(this.root,14,.05,14,0,-.04,0,0x303a43);
 const grid=new T.GridHelper(14,28,0x505d65,0x424c55);grid.position.y=-.01;this.root.add(grid);
 const all=topology();(this.overview?all:all.filter(r=>r.id===this.rid)).forEach((r,i)=>this.rack(r,i));
 if(this.overview){for(let i=0;i<2;i++){this.box(this.root,.65,.09,.4,i?.6:-.6,2.3,-2.25,0x9ba7b0,()=>this.info('SPINE'));}this.badge(this.root,'双 Spine · RDMA 上联',[0,2.6,-2.25],()=>this.info('SPINE'));const pool=new T.Group();pool.position.set(2.7,.5,-1);this.root.add(pool);this.box(pool,.6,1,1,0,0,0,0x596771,()=>this.info('POOL'));this.badge(pool,'RDMA Pool',[0,.7,0],()=>this.info('POOL'));this.wire(this.root,[[2.7,.8,-1.4],[2.7,2.5,-1.4],[.6,2.5,-2.25],[.6,2.3,-2.25]],0x678eae);}
 this.layout();this.toolbar();
};
View.prototype.layout=function(){this.items.forEach(item=>{item.target=0;item.dest.set(0,item.y,0);if(this.expanded&&!this.overview){if(item.kind==='server'){const i=item.rack.nodes.indexOf(item.nd);item.dest.set(i%2?1:-1,1.45-Math.floor(i/2)*.7,.75);}else item.dest.set(0,.3,1.05);}});this.cables.forEach(c=>c.visible=!this.expanded);this.caption.textContent=this.overview?'四机架实体布局 · 蓝色 RDMA 上联 · 绿色 CXL 直连 · 点击机架进入解剖':'42U 机柜 · 四台服务器 · 按配置显示 MHD · 拖动旋转，滚轮缩放；整柜展开后可逐台开盖。结构示意，非厂商 CAD。';};
View.prototype.inspect=function(item){
 if(this.overview){this.jump(item.rack.id);return;}
 this.selected=item;this.items.forEach(i=>i.target=i===item?1:0);item.dest.set(0,1.05,1.5);
 this.camTo=new T.Vector3(1.1,2.05,3.1);this.lookTo=new T.Vector3(0,1.22,1.5);
 this.parts.replaceChildren();this.button(this.parts,'返回整柜',()=>{this.selected=null;this.parts.replaceChildren();this.card.hidden=true;this.layout();this.home();});
 [...new Set(item.parts.map(p=>p.key))].forEach(k=>this.button(this.parts,INFO[k][0],()=>this.info(k)));
 const links=item.rack.links.filter(l=>item.kind==='server'?l.node===item.nd.id:l.mhdId===item.unit.id);
 this.details(item.id+' · '+(item.kind==='server'?'GPU 服务器':'共享 MHD'),item.kind==='server'?`角色：${item.nd.role}。RDMA 始终可用。CXL 连接：${links.map(l=>l.mhdId).join('、')||'未接入'}。点击器件或左侧部件目录查看说明。`:`容量 ${item.unit.capacityGB} GB；Host 接口 ${item.unit.hostInterfaces} 个；接入主机 ${links.map(l=>l.node).join('、')||'无'}；已用 ${S.computeMhdUsed(item.unit.id)} GB。`);
 this.cables.forEach(c=>c.visible=false);this.caption.textContent='器件展开为教学放大视图 · GPU/HBM、CPU、DRAM、NIC 与 CXL 接口分别说明 · 查看动作不改变实验状态';
};
View.prototype.sync=function(rid){if(rid)this.rid=rid;const key=JSON.stringify(topology())+'|'+this.rid;if(key!==this.key){this.key=key;this.build();}};
View.prototype.resize=function(){const w=this.host.clientWidth,h=this.host.clientHeight;if(w<10||h<10)return;this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();};
View.prototype.show=function(on){if(this.running===on)return;this.running=on;if(on){this.resize();this.last=performance.now();this.frame();}else{cancelAnimationFrame(this.raf);this.raf=null;}};
View.prototype.frame=function(){if(!this.running)return;this.raf=requestAnimationFrame(()=>this.frame());const now=performance.now(),dt=Math.min(.1,(now-this.last)/1000);this.last=now;const a=1-Math.exp(-dt*9);
 if(this.camTo){this.camera.position.lerp(this.camTo,a);this.controls.target.lerp(this.lookTo,a);if(this.camera.position.distanceTo(this.camTo)<.002)this.camTo=null;}
 this.items.forEach(item=>{item.g.position.lerp(item.dest,a);item.open+=(item.target-item.open)*a;item.lid.position.y=(item.kind==='server'?.0875:.0435)+item.open*.38;item.lid.position.x=item.open*-.3;item.lid.material.transparent=true;item.lid.material.opacity=1-item.open*.8;item.parts.forEach((p,i)=>{p.g.position.copy(p.base);p.g.position.y+=item.open*(.04+(i%3)*.035);});});
 this.controls.update();this.renderer.render(this.scene,this.camera);const w=this.host.clientWidth,h=this.host.clientHeight;this.labels.forEach(l=>{l.parent.updateWorldMatrix(true,false);const p=l.parent.localToWorld(l.offset.clone()).project(this.camera);l.el.style.display=p.z>1||p.z< -1||this.selected?'none':'';l.el.style.left=(p.x+1)*w/2+'px';l.el.style.top=(1-p.y)*h/2+'px';});
};
let rackView,overviewView;
window.__RACK3D__={available:true,mount(h){rackView=new View(h,false);},sync(id){rackView.sync(id);},show(on){if(rackView)rackView.show(on);},resize(){if(rackView)rackView.resize();},exitDissect(){if(rackView){rackView.selected=null;rackView.layout();rackView.home();}},dissectNode(id){const i=rackView&&rackView.items.find(i=>i.id===id);if(i)rackView.inspect(i);}};
window.HEAVY_CLUSTER={available:true,mount(h,opts){if(!overviewView)overviewView=new View(h,true);overviewView.jump=id=>opts.onJump(id);overviewView.sync();overviewView.show(true);},unmount(){if(overviewView)overviewView.show(false);},resize(){if(overviewView)overviewView.resize();}};
})();
