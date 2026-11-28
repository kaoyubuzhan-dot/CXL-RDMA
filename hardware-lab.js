/* Shared physical hardware view. Geometry is illustrative, not vendor CAD.
   No performance or deployment state is modified by inspection animations. */
(function () {
'use strict';
const T=window.THREE,S=window.__SIM__,model=window.HARDWARE_MODEL;
if(!T||!S||!model)return;
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
const serverY = index => 1.64 - index * .28;
const mhdY = index => .24 + index * .11;
const mhdPortX = index => -.15 + index * .09;
const spineX = index => index ? .6 : -.6;

function View(host,overview){
 this.host=host;this.overview=overview;this.rid='R1';this.expanded=false;this.selected=null;this.key='';this.items=[];this.labels=[];this.targets=[];this.rdmaCables=[];this.cxlCables=[];this.rackLabels=new Map();this.snapshot=null;this.refreshDetails=null;this.running=false;
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
 this.ui=document.createElement('div');this.ui.className='hl-ui';host.appendChild(this.ui);this.demoTimer=null;this.demoPhase=-1;
 this.bar=document.createElement('div');this.bar.className='hl-toolbar';this.ui.appendChild(this.bar);
 this.path=document.createElement('div');this.path.className='hl-path';this.ui.appendChild(this.path);
 this.parts=document.createElement('div');this.parts.className='hl-parts';this.ui.appendChild(this.parts);
 this.card=document.createElement('section');this.card.className='hl-card';this.card.hidden=true;this.ui.appendChild(this.card);
 this.caption=document.createElement('div');this.caption.className='hl-caption';this.ui.appendChild(this.caption);
 this.ray=new T.Raycaster();let down;
 this.renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];this.camTo=null;});
 this.renderer.domElement.addEventListener('wheel',()=>{this.camTo=null;},{passive:true});
 this.renderer.domElement.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;down=null;const b=this.renderer.domElement.getBoundingClientRect();this.ray.setFromCamera(new T.Vector2((e.clientX-b.left)/b.width*2-1,-(e.clientY-b.top)/b.height*2+1),this.camera);const hit=this.ray.intersectObjects(this.targets,false).find(({object})=>{for(let p=object;p;p=p.parent){if(!p.visible)return false;}return true;});if(hit)hit.object.userData.choose();});
 this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(host);this.toolbar();this.home();
}
View.prototype.button=function(parent,label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;parent.appendChild(b);return b;};
View.prototype.toolbar=function(){this.bar.replaceChildren();this.button(this.bar,'沉浸模式',()=>document.getElementById('app').classList.toggle('hl-focus'));this.button(this.bar,'配置面板',()=>document.getElementById('app').classList.toggle('hl-config-open'));this.button(this.bar,'复位视角',()=>this.home());if(!this.overview){this.button(this.bar,'机房总览',()=>{S.STATE.page='overview';S.STATE.view3d=true;window.__APP__.render();});this.button(this.bar,this.expanded?'收拢机柜':'整柜展开',()=>{this.expanded=!this.expanded;this.selected=null;this.parts.replaceChildren();this.card.hidden=true;this.layout();this.home();this.toolbar();});['R1','R2','R3','R4'].forEach(id=>{const b=this.button(this.bar,id,()=>{S.STATE.selectedRack=id;window.__APP__.render();});b.classList.toggle('active',id===this.rid);});}else {this.button(this.bar,'部署过程',()=>this.runDeploymentDemo());this.button(this.bar,'查看所选机架',()=>this.jump(this.rid));}};
View.prototype.runDeploymentDemo = function () {
 const targets = this.snapshot.racks.filter(rack => rack.units.length).map(rack => rack.id);
 if (!targets.length) {
   this.caption.textContent = '当前配置为全 RDMA，暂无 MHD 可回放。';
   return;
 }
 clearTimeout(this.demoTimer);
 this.closeDetails();
 const phases = [
   'T0 · 全 RDMA 基线：保留服务器、ToR、Spine 和远端内存池的连线',
   `T1 · 当前部署目标：${targets.join('、')}`,
   'T1 · 按当前配置安装 MHD',
   'T2 · 显示已配置的 CXL 主机连线'
 ];
 const apply = phase => {
   this.demoPhase = phase;
   this.caption.textContent = phases[phase];
   this.items.filter(item => item.kind === 'mhd').forEach(item => { item.g.visible = phase >= 2; });
   this.cxlCables.forEach(group => { group.visible = phase >= 3; });
   this.syncRackLabels();
   this.demoTimer = setTimeout(() => {
     if (phase + 1 < phases.length) apply(phase + 1);
     else this.stopDeploymentDemo();
   }, 1100);
 };
 apply(0);
};
View.prototype.stopDeploymentDemo = function () {
 clearTimeout(this.demoTimer);
 this.demoTimer = null;
 if (this.demoPhase === -1) return;
 this.demoPhase = -1;
 this.items.filter(item => item.kind === 'mhd').forEach(item => { item.g.visible = true; });
 this.cxlCables.forEach(group => { group.visible = true; });
 this.syncRackLabels();
 this.syncCaption();
};
View.prototype.home=function(){this.camTo=this.overview?new T.Vector3(6,5.8,7.5):this.expanded?new T.Vector3(4.4,3.7,6.4):new T.Vector3(2.9,2.2,3.9);this.lookTo=new T.Vector3(0,1.05,0);};
View.prototype.mat=function(c,metal=.3,rough=.6){return new T.MeshStandardMaterial({color:c,metalness:metal,roughness:rough});};
View.prototype.box=function(parent,w,h,d,x,y,z,color,choose){const mesh=new T.Mesh(new T.BoxGeometry(w,h,d),this.mat(color));mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);if(choose){mesh.userData.choose=choose;this.targets.push(mesh);}return mesh;};
View.prototype.badge=function(parent,text,offset,fn){const el=this.button(this.ui,text,fn);el.className='hl-label';this.labels.push({parent,offset:new T.Vector3(...offset),el});};
View.prototype.wire=function(parent,points,color){const c=new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p)));const m=new T.Mesh(new T.TubeGeometry(c,20,.007,5,false),this.mat(color,.1,.8));parent.add(m);return m;};
View.prototype.environment=function(){
 const room=new T.Group();room.name='data-center-room';this.root.add(room);
 // Concrete floor, raised service strips and a deliberately open ceiling frame keep the
 // equipment readable while establishing a real room scale around the four racks.
 this.box(room,13.5,.08,12.5,0,-.08,0,0x252d33);
 const aisle=new T.Mesh(new T.PlaneGeometry(8.6,1.35),new T.MeshStandardMaterial({color:0x303b40,metalness:.15,roughness:.9}));
 aisle.rotation.x=-Math.PI/2;aisle.position.set(0,.005,.25);room.add(aisle);
 [-3.9,3.9].forEach(x=>this.box(room,.08,3.05,12.1,x,1.48,0,0x303b42));
 this.box(room,13.4,3.05,.08,0,1.48,-5.85,0x303b42);
 [-4.9,4.9].forEach(x=>this.box(room,.12,3.25,12.3,x,1.62,0,0x1f292f));
 // Keep the front side open so the camera can enter the room instead of looking
 // through an opaque wall; the rear wall still establishes depth and scale.
 this.box(room,13.4,3.25,.12,0,1.62,-5.85,0x1f292f);
 // Ceiling cable trays and cool-white luminaires convey the overhead infrastructure.
 [-2.7,2.7].forEach(x=>{this.box(room,.16,.12,11.6,x,3.15,0,0x4d5960);this.box(room,.045,.028,10.8,x,3.08,0,0x83b9b0);});
 [-2.2,2.2].forEach(z=>{this.box(room,11.2,.1,.14,0,3.13,z,0x4d5960);});
 [-1.15,1.15].forEach(x=>{const lamp=new T.Mesh(new T.BoxGeometry(.7,.025,2.5),new T.MeshBasicMaterial({color:0xcce9e4}));lamp.position.set(x,3.18,.1);room.add(lamp);});
 // Safety-yellow floor markers provide a physical reference for the service aisle.
 [-.72,.72].forEach(x=>this.box(room,.018,.006,11.5,x,.012,.05,0xb39a4a));
};
View.prototype.details=function(title,desc,tag='硬件结构 · 示意模型'){this.card.replaceChildren();this.card.hidden=false;this.button(this.card,'关闭',()=>this.closeDetails()).className='hl-close';const small=document.createElement('small');small.textContent=tag;const h=document.createElement('h2');h.textContent=title;const p=document.createElement('p');p.textContent=desc;this.card.append(small,h,p);};
View.prototype.closeDetails = function () {
 this.card.hidden = true;
 this.refreshDetails = null;
};
View.prototype.info=function(key){const d=INFO[key];if(d){this.refreshDetails=null;this.details(d[0],d[1]);}};
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
  const count=unit.hostInterfaces;for(let i=0;i<count;i++)this.box(g,.035,.02,.014,mhdPortX(i),0,-.389,0x6daca0,()=>this.info('CTRL'));
 }
 if(!this.overview)this.badge(g,id,[.0,.02,.48],choose);
 return item;
};
View.prototype.rack=function(r,index){
 const group=new T.Group();this.root.add(group);if(this.overview)group.position.set((index%2-.5)*2.2,0,(Math.floor(index/2)-.5)*2.6);
 const select = () => {
   S.STATE.selectedRack = r.id;
   if (this.overview) {
     this.stopDeploymentDemo();
     this.rid = r.id;
     this.refreshDetails = () => this.describeRack(r.id);
     this.refreshDetails();
     this.syncRackLabels();
     window.__APP__.renderRightOnly();
   } else {
     this.expanded = !this.expanded;
     this.selected = null;
     this.parts.replaceChildren();
     this.closeDetails();
     this.layout();
     this.toolbar();
     this.home();
   }
 };
 // 600 mm cabinet / 19-inch mounting rails / nominal 42U height, 1m depth.
 this.box(group,.6,.1,1,0,.05,0,0x252c32,select);this.box(group,.6,.04,1,0,2.04,0,0x363f46,select);
 [-1,1].forEach(x=>[-1,1].forEach(z=>{this.box(group,.035,1.98,.035,x*.282,1.04,z*.47,0x48545c,select);for(let u=0;u<42;u++)this.box(group,.014,.008,.006,x*.253,.145+u*.04445,z*.454,0x10161b);}));
 // Narrow side panels leave the service front open; rear PDU and cable management.
 this.box(group,.008,1.8,.95,-.299,1.05,0,0x303b44,select);this.box(group,.035,1.7,.05,.24,1,-.43,0x20262d,select);
 for(let i=0;i<12;i++)this.box(group,.018,.025,.01,.24,.25+i*.12,-.397,0x68777f);
 const tor=new T.Group();group.add(tor);tor.position.y=1.94;this.box(tor,.45,.044,.4,0,0,0,0x7e8b93,()=>this.info('TOR'));
 for(let i=0;i<16;i++)this.box(tor,.019,.017,.01,-.19+i*.025,0,.207,0x111e26,()=>this.info('TOR'));
 r.nodes.forEach((nd,i)=>{const y=serverY(i);this.device(group,nd.deviceId,y,'server',nd,null,r);[-1,1].forEach(sign=>this.box(group,.017,.025,.8,sign*.235,y-.09,0,0x818b92));});
 r.units.forEach((m,i)=>this.device(group,m.id,mhdY(i),'mhd',null,m,r));
 if(!r.units.length&&!this.overview)this.badge(group,'MHD 预留区 · 未部署',[0,.25,.48],()=>this.details('MHD 预留安装区','当前机架没有 CXL 设备。可在左侧部署配置中添加；查看预留区不会改变实验状态。'));
 this.badge(group,r.id,[0,2.2,0],select);
 this.rackLabels.set(r.id, this.labels[this.labels.length - 1].el);
 const rdma = new T.Group();
 const cxl = new T.Group();
 group.add(rdma, cxl);
 this.rdmaCables.push(rdma);
 this.cxlCables.push(cxl);
 r.downlinks.forEach(({ from }, i) => {
   const y = serverY(r.nodes.findIndex(node => node.deviceId === from));
   this.wire(rdma, [[-.12,y,-.39],[-.32,y,-.47],[-.32,1.94,-.47],[-.17+i*.1,1.94,-.2]], 0x678eae);
 });
 r.links.forEach(({ node, mhdId, portIndex }, i) => {
   const y = serverY(r.nodes.findIndex(host => host.id === node));
   const deviceY = mhdY(r.units.findIndex(unit => unit.id === mhdId));
   const channelX = .35 + i * .012;
   this.wire(cxl, [[.12,y,-.39],[channelX,y,-.44],[channelX,deviceY,-.44],[mhdPortX(portIndex),deviceY,-.39]], 0x80b9a2);
 });
 if (this.overview) {
   r.uplinks.forEach(({to}) => {
     const sx = spineX(this.snapshot.network.spines.indexOf(to));
     const {x,z} = group.position;
     this.wire(this.root, [[x,1.94,z-.2],[x,2.5,z-.3],[sx,2.5,-2.25],[sx,2.3,-2.25]], 0x678eae);
   });
 }
};
View.prototype.describeRack = function (id) {
 const rack = this.snapshot.racks.find(item => item.id === id);
 const capacity = rack.units.reduce((sum, unit) => sum + unit.capacityGB, 0);
 const hosts = rack.links.map(link => `${link.node} → ${link.mhdId}`).join('、') || '无';
 const connections = this.snapshot.network.logicalLinks.filter(link => link.a === id || link.b === id);
 const loads = connections.map(link => `${link.a}–${link.b} ${link.utilization == null ? '未设定' : `${link.utilization}%`}`).join('、');
 this.details(`${id} · 42U 机柜`,
   `${rack.nodes.length} 台服务器 · ${rack.units.length} 台 MHD（${capacity} GB）\nCXL 接入：${hosts}\nRDMA：${rack.torId} 上联 ${rack.uplinks.map(link => link.to).join('、')}\n机架间配置负载：${loads}`);
 this.button(this.card,'进入机架解剖',()=>this.jump(id));
};
View.prototype.describePool = function () {
 this.refreshDetails = () => {
   const pool = this.snapshot.network.pool;
   this.details(`${pool.id} · RDMA 远端内存池`, `容量 ${pool.capacityGB} GB · 已用 ${pool.usedGB} GB\nRDMA 上联：${pool.uplink}`);
 };
 this.refreshDetails();
};
View.prototype.build=function(){
 if(this.root){this.scene.remove(this.root);const geom=new Set(),mat=new Set();this.root.traverse(o=>{if(o.geometry)geom.add(o.geometry);if(o.material)mat.add(o.material);});geom.forEach(g=>g.dispose());mat.forEach(m=>m.dispose());}
 this.labels.forEach(l=>l.el.remove());this.labels=[];this.items=[];this.targets=[];this.rdmaCables=[];this.cxlCables=[];this.rackLabels=new Map();this.selected=null;this.parts.replaceChildren();this.closeDetails();
 this.root=new T.Group();this.scene.add(this.root);
 this.environment();
 const grid=new T.GridHelper(14,28,0x505d65,0x424c55);grid.position.y=-.01;this.root.add(grid);
 this.visibleRacks().forEach((rack, index) => this.rack(rack, index));
 if (this.overview) {
   const {spines, pool} = this.snapshot.network;
   spines.forEach((id, index) => {
     const x = spineX(index);
     this.box(this.root,.65,.09,.4,x,2.3,-2.25,0x9ba7b0,()=>this.info('SPINE'));
     this.badge(this.root,id,[x,2.6,-2.25],()=>this.info('SPINE'));
   });
   const enclosure = new T.Group();
   enclosure.position.set(2.7,.5,-1);
   this.root.add(enclosure);
   this.box(enclosure,.6,1,1,0,0,0,0x596771,()=>this.describePool());
   this.badge(enclosure,pool.id,[0,.7,0],()=>this.describePool());
   const sx = spineX(spines.indexOf(pool.uplink));
   this.wire(this.root,[[2.7,.8,-1.4],[2.7,2.5,-1.4],[sx,2.5,-2.25],[sx,2.3,-2.25]],0x678eae);
 }
 this.syncRackLabels();
 this.layout();this.toolbar();
};
View.prototype.visibleRacks = function () {
 return this.overview ? this.snapshot.racks : this.snapshot.racks.filter(rack => rack.id === this.rid);
};
View.prototype.syncRackLabels = function () {
 const showCxl = this.demoPhase === -1 || this.demoPhase >= 3;
 for (const [id, label] of this.rackLabels) {
   const rack = this.snapshot.racks.find(item => item.id === id);
   const mhdCount = this.demoPhase === -1 || this.demoPhase >= 2 ? rack.units.length : 0;
   label.textContent = mhdCount ? `${id} · ${mhdCount} MHD${showCxl ? '' : ' 安装中'}` : `${id} · RDMA`;
   label.classList.toggle('active', id === this.rid);
 }
};
View.prototype.syncCaption = function () {
 if (this.demoPhase !== -1 || this.selected) return;
 if (this.overview) {
   const { racks, network } = this.snapshot;
   const deployed = racks.filter(rack => rack.units.length).map(rack => rack.id);
   this.caption.textContent = `${racks.length} 个 42U 机柜 · ${network.spines.length} 台 Spine · ${deployed.length ? `${deployed.join('、')} 部署 MHD` : '全 RDMA'} · 点击机架查看设备与连线`;
   return;
 }
 const rack = this.visibleRacks()[0];
 const capacity = rack.units.reduce((sum, unit) => sum + unit.capacityGB, 0);
 this.caption.textContent = `${rack.id} · ${rack.nodes.length} 台服务器 · ${rack.units.length} 台 MHD（${capacity} GB） · ${rack.links.length} 台主机接入 CXL`;
};
View.prototype.layout = function () {
 this.items.forEach(item => {
   item.target = 0;
   item.dest.set(0,item.y,0);
   if (!this.expanded || this.overview) return;
   if (item.kind === 'server') {
     const index = item.rack.nodes.indexOf(item.nd);
     item.dest.set(index % 2 ? 1 : -1, 1.45 - Math.floor(index / 2) * .7, .75);
   } else {
     item.dest.set(0,item.y,1.05);
   }
 });
 [...this.rdmaCables, ...this.cxlCables].forEach(group => { group.visible = !this.expanded; });
 this.path.textContent = this.overview ? '机房总览  /  当前部署' : `机房  /  ${this.rid}  /  ${this.expanded ? '整柜展开' : '整柜视图'}`;
 this.syncCaption();
};
View.prototype.inspect=function(item){
 if(this.overview){this.stopDeploymentDemo();this.jump(item.rack.id);return;}
 this.selected=item;this.items.forEach(i=>i.target=i===item?1:0);item.dest.set(0,1.05,1.5);
 this.path.textContent=`机房  /  ${this.rid}  /  ${item.id}  /  器件解剖`;
 this.camTo=new T.Vector3(1.1,2.05,3.1);this.lookTo=new T.Vector3(0,1.22,1.5);
 this.parts.replaceChildren();this.button(this.parts,'返回整柜',()=>this.exitDissect());
 [...new Set(item.parts.map(p=>p.key))].forEach(k=>this.button(this.parts,INFO[k][0],()=>this.info(k)));
 this.refreshDetails = () => this.describeDevice(item);
 this.refreshDetails();
 [...this.rdmaCables, ...this.cxlCables].forEach(group => { group.visible = false; });
 this.caption.textContent='点击器件或部件目录查看结构和功能。';
};
View.prototype.describeDevice = function (item) {
 const rack = this.visibleRacks()[0];
 if (item.kind === 'server') {
   const links = rack.links.filter(link => link.node === item.nd.id);
   this.details(`${item.id} · GPU 服务器`,
     `角色：${item.nd.role}\nRDMA：${rack.torId}\nCXL：${links.map(link => `${link.mhdId} 接口 ${link.portIndex + 1}`).join('、') || '未接入'}`);
   return;
 }
 const unit = rack.units.find(entry => entry.id === item.id);
 const links = rack.links.filter(link => link.mhdId === unit.id);
 this.details(`${item.id} · 共享 MHD`,
   `容量 ${unit.capacityGB} GB · 已用 ${unit.usedGB} GB\nHost 接口 ${unit.hostInterfaces} 个\n已接入：${links.map(link => `${link.node}（接口 ${link.portIndex + 1}）`).join('、') || '无'}`);
};
View.prototype.exitDissect = function () {
 this.selected = null;
 this.parts.replaceChildren();
 this.closeDetails();
 this.layout();
 this.home();
};
View.prototype.sync = function (rid, snapshot) {
 const selectedRack = snapshot.racks.find(rack => rack.id === rid)?.id ?? snapshot.racks[0].id;
 const rackChanged = this.rid !== selectedRack;
 if (!rackChanged && this.snapshot === snapshot) return;
 this.rid = selectedRack;
 this.snapshot = snapshot;
 const key = JSON.stringify(this.visibleRacks().map(({id, nodes, units, links}) =>
   [id, nodes, units.map(unit => [unit.id, unit.hostInterfaces]), links]));
 if (key !== this.key) {
   this.stopDeploymentDemo();
   const details = this.overview ? this.refreshDetails : null;
   if (rackChanged && !this.overview) this.expanded = false;
   this.key = key;
   this.build();
   if (details) {
     this.refreshDetails = details;
     details();
   }
   if (rackChanged && !this.overview) this.home();
   return;
 }
 this.syncRackLabels();
 this.syncCaption();
 if (this.refreshDetails) this.refreshDetails();
};
View.prototype.resize=function(){const w=this.host.clientWidth,h=this.host.clientHeight;if(w<10||h<10)return;this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();};
View.prototype.show=function(on){if(this.running===on)return;this.running=on;if(on){this.resize();this.last=performance.now();this.frame();}else{cancelAnimationFrame(this.raf);this.raf=null;this.stopDeploymentDemo();}};
View.prototype.frame=function(){if(!this.running)return;this.raf=requestAnimationFrame(()=>this.frame());const now=performance.now(),dt=Math.min(.1,(now-this.last)/1000);this.last=now;const a=1-Math.exp(-dt*9);
 if(this.camTo){this.camera.position.lerp(this.camTo,a);this.controls.target.lerp(this.lookTo,a);if(this.camera.position.distanceTo(this.camTo)<.002)this.camTo=null;}
 this.items.forEach(item=>{item.g.position.lerp(item.dest,a);item.open+=(item.target-item.open)*a;item.lid.position.y=(item.kind==='server'?.0875:.0435)+item.open*.38;item.lid.position.x=item.open*-.3;item.lid.material.transparent=true;item.lid.material.opacity=1-item.open*.8;item.parts.forEach((p,i)=>{p.g.position.copy(p.base);p.g.position.y+=item.open*(.04+(i%3)*.035);});});
 this.controls.update();this.renderer.render(this.scene,this.camera);const w=this.host.clientWidth,h=this.host.clientHeight;this.labels.forEach(l=>{l.parent.updateWorldMatrix(true,false);const p=l.parent.localToWorld(l.offset.clone()).project(this.camera);l.el.style.display=p.z>1||p.z< -1||this.selected?'none':'';l.el.style.left=(p.x+1)*w/2+'px';l.el.style.top=(1-p.y)*h/2+'px';});
};
let rackView,overviewView;
window.__RACK3D__={available:true,mount(h){rackView=new View(h,false);},sync(id){rackView.sync(id,model.snapshot());},show(on){if(rackView)rackView.show(on);},resize(){if(rackView)rackView.resize();},exitDissect(){if(rackView)rackView.exitDissect();},dissectNode(id){const i=rackView&&rackView.items.find(i=>i.id===id);if(i)rackView.inspect(i);}};
window.HEAVY_CLUSTER={available:true,mount(h,opts){if(!overviewView)overviewView=new View(h,true);overviewView.jump=opts.onJump;overviewView.sync(S.STATE.selectedRack,model.snapshot());overviewView.show(true);},unmount(){if(overviewView)overviewView.show(false);},resize(){if(overviewView)overviewView.resize();}};
})();
