/* Daybook kids game: emoji mood faces, original pixel art (coin, block, cloud, rain) + tiny 8-bit sound effects. Shared by index.html and kids.html. */
(function(){
  var COL = {K:'#1F1A17',Y:'#FFD23F',W:'#FFFFFF',B:'#FF8FA3',T:'#4DB6FF',G:'#F4B71A',D:'#C98A00',L:'#FFF1A8',R:'#D9433A',r:'#9E2A22',p:'#F07A70',C:'#FFFFFF',c:'#DDEFFF',S:'#8FA3B8',s:'#6C8199'};
  var COIN = ["..KKKK..",".KGGGGK.","KGLGGDGK","KGLGGDGK","KGLGGDGK","KGLGGDGK",".KGDDDK.","..KKKK.."];
  var BLOCK = ["KKKKKKKK","KppRRRrK","KpRKKRrK","KRRKKRrK","KRRRRRrK","KRRKKRrK","KrrrrrrK","KKKKKKKK"];
  var CLOUD = ["....CCCC......","..CCCCCCCC.CC.",".CCCCCCCCCCCCC","CCCCCCCCCCCCCC","CCcccccccccccC",".cccccccccccc."];
  var RAIN = ["..SSSS..","SSSSSSSS","ssssssss","..T..T..",".T..T..T"];
  function pix(grid, s){
    var h = grid.length, w = grid[0].length, r = '';
    for(var y=0;y<h;y++) for(var x=0;x<w;x++){ var c = COL[grid[y][x]]; if(c) r += '<rect x="'+x+'" y="'+y+'" width="1" height="1" fill="'+c+'"/>'; }
    return '<svg class="pix" width="'+(w*s)+'" height="'+(h*s)+'" viewBox="0 0 '+w+' '+h+'" shape-rendering="crispEdges" aria-hidden="true">'+r+'</svg>';
  }
  function emo(ch, px, label){ return '<span class="emo" role="img" aria-label="' + label + '" style="display:block;font-size:' + Math.round(px) + 'px;line-height:1;font-family:\'Apple Color Emoji\',\'Segoe UI Emoji\',\'Noto Color Emoji\',sans-serif">' + ch + '</span>'; }
  function mood(yes, no){ var b = (yes||0) - (no||0); return b>=3 ? 'happy' : b>=1 ? 'smile' : b===0 ? 'meh' : b>=-2 ? 'sad' : 'cry'; }
  var EMOJI = {happy:'😄', smile:'🙂', meh:'😐', sad:'😟', cry:'😢'};
  var MOOD_TEXT ={happy:'Super happy!', smile:'Happy', meh:'Even', sad:'A bit sad', cry:'Very sad'};
  var ctx = null, muted = false;
  try{ muted = localStorage.getItem('daybook-kids-mute') === '1'; }catch(_){}
  function ac(){ if(!ctx){ var A = window.AudioContext || window.webkitAudioContext; if(!A) return null; ctx = new A(); } if(ctx.state === 'suspended') ctx.resume(); return ctx; }
  function tone(a, f, t, d, type, vol){ var o = a.createOscillator(), g = a.createGain(); o.type = type || 'square'; o.frequency.setValueAtTime(f, t); g.gain.setValueAtTime(vol || .08, t); g.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + .02); return o; }
  function sfx(kind){
    if(muted) return; var a = ac(); if(!a) return; var t = a.currentTime;
    if(kind === 'coin'){ tone(a, 988, t, .08); tone(a, 1319, t + .08, .3); }
    else if(kind === 'bonk'){ var o = tone(a, 220, t, .25, 'square', .1); o.frequency.exponentialRampToValueAtTime(90, t + .25); }
    else if(kind === 'use'){ tone(a, 660, t, .07, 'triangle', .1); tone(a, 440, t + .07, .14, 'triangle', .1); }
  }
  window.PX = {
    // Faces are emoji (clearer than pixel art); s keeps the old pixel-scale sizing (12px per step).
    face: function(m, s){ return '<span class="emo" role="img" aria-label="' + (MOOD_TEXT[m] || '') + '" style="display:block;font-size:' + Math.round(11 * (s || 4)) + 'px;line-height:1;font-family:\'Apple Color Emoji\',\'Segoe UI Emoji\',\'Noto Color Emoji\',sans-serif">' + (EMOJI[m] || EMOJI.meh) + '</span>'; },
    // Yes/No counters are emoji too, matching the YES/NO buttons; s keeps the old sizing (8px per step).
    coin: function(s){ return emo('👍', 8 * (s || 3), 'Yes'); },
    block: function(s){ return emo('👎', 8 * (s || 3), 'No'); },
    sound: function(on){ return on
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.5 4.5 0 010 6M18.5 6.5a8 8 0 010 11"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>'; },
    cloud: function(s){ return pix(CLOUD, s || 6); },
    rain: function(s){ return pix(RAIN, s || 4); },
    mood: mood, moodText: function(m){ return MOOD_TEXT[m] || ''; },
    sfx: sfx, unlock: function(){ ac(); },
    isMuted: function(){ return muted; },
    setMuted: function(v){ muted = !!v; try{ localStorage.setItem('daybook-kids-mute', muted ? '1' : '0'); }catch(_){} }
  };
})();
