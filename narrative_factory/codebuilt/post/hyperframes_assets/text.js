// codex · gpt-6.1-sol · 2026-11-19 14:29 +02:00. Original DOM blocks; all state is a function of seek time.
(() => {
  const d = window.TEXT_DATA, root = document.getElementById('root');
  root.style.width = `${d.width}px`; root.style.height = `${d.height}px`;
  root.style.fontSize = `${d.width / 108}px`;
  document.body.style.width = `${d.width}px`; document.body.style.height = `${d.height}px`;
  const host = document.getElementById('graphics'), caps = document.getElementById('captions');
  function node(tag, text, parent) {
    const el = document.createElement(tag); el.textContent = text || ''; parent.appendChild(el); return el;
  }
  const blocks = [];
  function block(kind, item, text) {
    const el = node('div', text, host); el.className = `panel ${kind}`;
    const a = el.animate([{opacity:0, transform:'translateY(18px)'}, {opacity:1, transform:'translateY(0)'}],
      {duration:180, fill:'both', easing:'ease-out'}); a.pause();
    const b = {kind, item, el, a}; blocks.push(b); return b;
  }
  for (const item of d.spec.labels) block('label', item, [item.title,item.value].filter(Boolean).join(' · '));
  for (const item of d.spec.big) { const b = block('big', item, item.text); node('small', item.sub, b.el); }
  if (d.spec.tag) block('tag', d.spec.tag, d.spec.tag.text);
  if (d.spec.counter) {
    const b = block('counter', d.spec.counter); node('small', b.item.label, b.el);
    b.number = node('strong', '', b.el); node('span', ` ${b.item.unit || ''}`, b.el);
  }
  for (const item of d.spec.bars) { const b = block('bar',item,item.label); b.fill = node('i','',b.el); }
  for (const item of d.spec.measures) {
    const b = block('measure',item); b.el.className = 'measure'; node('span',item.text,b.el);
  }
  const groups = d.groups.map(g => ({...g, words:g.words.map(w => ({...w, el:node('span', w.text, caps)}))}));
  const flash = document.getElementById('flash');
  const flashAnimation = flash.animate([{opacity:0},{opacity:.45,offset:.25},{opacity:0}],{duration:240,fill:'both'});
  flashAnimation.pause();
  function seek(t) {
    const f = Math.max(0, Math.floor(t*d.fps+1e-6));
    for (const b of blocks) {
      const {item, el} = b; let on = t >= item.from && t < item.to;
      b.a.currentTime = Math.max(0,Math.min(180,(t-item.from)*1000));
      if (b.kind === 'counter') b.number.textContent = d.numbers[Math.min(f,d.numbers.length-1)];
      if (b.kind === 'label') {
        const p = d.points[item.anchor][f]; on = on && !!p;
        if (p) {
          // Keep the label on screen; its border stays adjacent to the projected point.
          const left = item.side === 'left' || (item.side === 'auto' && p[0] > .55);
          el.style.left = `${Math.max(.1,Math.min(.55,p[0]+(left ? -.33 : .02)))*100}%`;
          el.style.top = `${Math.max(.13,Math.min(.60,p[1]))*100}%`;
        }
      }
      if (b.kind === 'bar') {
        const v = d.values[item.value][f]; b.fill.style.transform = `scaleX(${Math.max(0,Math.min(1,(v-item.min)/(item.max-item.min)))})`;
      }
      if (b.kind === 'measure') {
        const a = d.points[item.a][f], z = d.points[item.b][f]; on = on && !!a && !!z;
        if (a && z) { const x=(z[0]-a[0])*d.width, y=(z[1]-a[1])*d.height;
          el.style.left=`${a[0]*100}%`; el.style.top=`${a[1]*100}%`;
          el.style.width=`${Math.hypot(x,y)}px`; el.style.transform=`rotate(${Math.atan2(y,x)}rad)`; }
      }
      el.style.display = on ? 'block' : 'none';
    }
    for (const g of groups) for (const w of g.words) {
      const on = t >= g.start && t < g.end;
      w.el.style.display = on ? 'inline-block' : 'none';
      w.el.style.opacity = t >= w.start ? '1' : '0';
      w.el.className = w.key && t >= w.start ? 'key' : '';
      const k = Math.max(0,Math.min(1,(t-w.start)/.12));
      w.el.style.transform = `translateY(${(1-k)*12}px) scale(${.88+.12*k})`;
    }
    // Fit unusually long words to the title-safe width using this local font's real metrics.
    caps.style.fontSize = '5em';
    const widest = Math.max(0,...groups.filter(g=>t>=g.start&&t<g.end).map(g=>g.words.reduce((sum,w)=>sum+w.el.getBoundingClientRect().width+d.width*.012,0)));
    if (widest > d.width*.78) caps.style.fontSize = `${5*d.width*.78/widest}em`;
    const age = Math.min(...d.spec.big.map(b=>t-b.from).filter(age=>age>=0),Infinity);
    flashAnimation.currentTime = age < .24 ? age*1000 : 240;
  }
  window.addEventListener('hf-seek',e=>seek(e.detail.time));
  document.fonts.ready.then(()=>seek(0)); seek(0);
})();
