const KEY="jml_prospection_v1";let prospects=load();const $=id=>document.getElementById(id);
function load(){try{return JSON.parse(localStorage.getItem(KEY)||"[]")}catch(e){return[]}}
function save(){localStorage.setItem(KEY,JSON.stringify(prospects));render()}
function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function now(){return new Date().toISOString()}
function openForm(item=null){
  $("prospectForm").reset();$("editId").value=item?.id||"";$("dialogTitle").textContent=item?"Modifier le prospect":"Nouveau prospect";
  $("history").innerHTML=item&&item.history?.length?item.history.slice().reverse().map(h=>`<div class="history-item"><strong>${esc(h.type)}</strong><span>${new Date(h.date).toLocaleString("fr-FR")}</span><p>${esc(h.text)}</p></div>`).join(""):"<div class='meta'>Aucun historique.</div>";
  if(item){
    for(const k of ["address","district","area","land","rooms","bedrooms","price","dpe","nextFollow","sourceUrl","description","notes"])if($(k))$(k).value=item[k]||"";
    $("formCity").value=item.city||"";$("formType").value=item.type||"Maison";$("formStatus").value=item.status||"Nouveau";
  }
  $("dialog").showModal()
}
function closeForm(){$("dialog").close()}
function formData(){return{address:$("address").value.trim(),city:$("formCity").value.trim(),district:$("district").value.trim(),type:$("formType").value,area:Number($("area").value)||0,land:Number($("land").value)||0,rooms:Number($("rooms").value)||0,bedrooms:Number($("bedrooms").value)||0,price:Number($("price").value)||0,dpe:$("dpe").value,status:$("formStatus").value,nextFollow:$("nextFollow").value,sourceUrl:$("sourceUrl").value.trim(),description:$("description").value.trim(),notes:$("notes").value.trim()}}
function badgeClass(s){return s==="Mandat obtenu"?"green":s==="À relancer"?"hot":""}
function render(){
  const q=$("q").value.toLowerCase().trim(),city=$("city").value.toLowerCase().trim(),type=$("type").value,status=$("status").value;
  let rows=prospects.filter(p=>(!q||[p.address,p.city,p.district,p.description,p.notes].join(" ").toLowerCase().includes(q))&&(!city||p.city.toLowerCase().includes(city))&&(!type||p.type===type)&&(!status||p.status===status));
  const sort=$("sort").value;if(sort==="city")rows.sort((a,b)=>a.city.localeCompare(b.city));else if(sort==="price")rows.sort((a,b)=>b.price-a.price);else if(sort==="follow")rows.sort((a,b)=>(a.nextFollow||"9999").localeCompare(b.nextFollow||"9999"));else rows.sort((a,b)=>(b.updatedAt||"").localeCompare(a.updatedAt||""));
  $("resultCount").textContent=rows.length+" résultat"+(rows.length>1?"s":"");$("empty").style.display=rows.length?"none":"block";
  $("list").innerHTML=rows.map(p=>`<article class="card"><div class="card-head"><div><div class="address">${esc(p.address)}</div><div class="meta">${esc(p.city)}${p.district?" · "+esc(p.district):""} · ${esc(p.type)}</div></div><span class="badge ${badgeClass(p.status)}">${esc(p.status)}</span></div>${p.price?`<div class="price">${p.price.toLocaleString("fr-FR")} €</div>`:""}<div class="details">${p.area?`<span class="detail">${p.area} m²</span>`:""}${p.land?`<span class="detail">Terrain ${p.land} m²</span>`:""}${p.rooms?`<span class="detail">${p.rooms} pièces</span>`:""}${p.bedrooms?`<span class="detail">${p.bedrooms} ch.</span>`:""}${p.dpe?`<span class="detail">DPE ${p.dpe}</span>`:""}</div>${p.description?`<div class="signal">${esc(p.description)}</div>`:""}<div class="meta">Prochaine relance : ${p.nextFollow?new Date(p.nextFollow+"T00:00:00").toLocaleDateString("fr-FR"):"non définie"}</div><div class="card-actions"><button class="ghost" data-edit="${p.id}">Ouvrir / modifier</button>${p.sourceUrl?`<a class="ghost" href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">Source</a>`:""}<button class="ghost" data-delete="${p.id}">Supprimer</button></div></article>`).join("");
  $("statTotal").textContent=prospects.length;$("statNew").textContent=prospects.filter(p=>p.status==="Nouveau").length;$("statFollow").textContent=prospects.filter(p=>p.status==="À relancer").length;$("statMandates").textContent=prospects.filter(p=>p.status==="Mandat obtenu").length
}
$("addBtn").onclick=()=>openForm();$("closeBtn").onclick=closeForm;$("cancelBtn").onclick=closeForm;
$("prospectForm").onsubmit=e=>{
  e.preventDefault();const d=formData(),id=$("editId").value,action=$("actionNote").value.trim(),date=now();
  if(id){
    const i=prospects.findIndex(p=>p.id===id);if(i<0)return;const old=prospects[i];
    const history=[...(old.history||[])];if(old.status!==d.status)history.push({date,type:"Changement de statut",text:`${old.status} → ${d.status}`});if(action)history.push({date,type:"Action / note",text:action});
    prospects[i]={...old,...d,history,updatedAt:date}
  }else{
    const history=[{date,type:"Création",text:action||"Prospect créé"}];prospects.push({id:crypto.randomUUID(),...d,history,createdAt:date,updatedAt:date})
  }
  save();closeForm()
};
$("resetBtn").onclick=()=>{$("q").value="";$("city").value="";$("type").value="";$("status").value="";render()};
["q","city","type","status","sort"].forEach(id=>$(id).addEventListener("input",render));
$("list").onclick=e=>{const edit=e.target.closest("[data-edit]"),del=e.target.closest("[data-delete]");if(edit){const p=prospects.find(x=>x.id===edit.dataset.edit);if(p)openForm(p)}if(del&&confirm("Supprimer ce prospect ?")){prospects=prospects.filter(x=>x.id!==del.dataset.delete);save()}};
render();