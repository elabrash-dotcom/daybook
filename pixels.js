/* Daybook kids game: original pixel art (faces, coin, block, cloud) + tiny 8-bit sound effects. Shared by index.html and kids.html. */
(function(){
  var F = {
    happy:["...KKKKKK...","..KYYYYYYK..",".KYYYYYYYYK.","KYYKYYYYKYYK","KYYKYYYYKYYK","KYBYYYYYYBYK","KYKYYYYYYKYK","KYYKWWWWKYYK","KYYYKKKKYYYK",".KYYYYYYYYK.","..KYYYYYYK..","...KKKKKK..."],
    smile:["...KKKKKK...","..KYYYYYYK..",".KYYYYYYYYK.","KYYKYYYYKYYK","KYYKYYYYKYYK","KYYYYYYYYYYK","KYYYYYYYYYYK","KYYKYYYYKYYK","KYYYKKKKYYYK",".KYYYYYYYYK.","..KYYYYYYK..","...KKKKKK..."],
    meh:["...KKKKKK...","..KYYYYYYK..",".KYYYYYYYYK.","KYYKYYYYKYYK","KYYKYYYYKYYK","KYYYYYYYYYYK","KYYYYYYYYYYK","KYYYYYYYYYYK","KYYKKKKKKYYK",".KYYYYYYYYK.","..KYYYYYYK..","...KKKKKK..."],
    sad:["...KKKKKK...","..KYYYYYYK..",".KYKYYYYKYK.","KYYYKYYKYYYK","KYYKYYYYKYYK","KYYKYYYYKYYK","KYYYYYYYYYYK","KYYYYYYYYYYK","KYYYKKKKYYYK",".KYKYYYYKYK.","..KYYYYYYK..","...KKKKKK..."],
    cry:["...KKKKKK...","..KYYYYYYK..",".KYKYYYYKYK.","KYYYKYYKYYYK","KYYKYYYYKYYK","KYYTYYYYTYYK","KYYTYYYYTYYK","KYYYYYYYYYYK","KYYYKKKKYYYK",".KYKYYYYKYK.","..KYYYYYYK..","...KKKKKK..."]
  };
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
  function mood(yes, no){ var b = (yes||0) - (no||0); return b>=3 ? 'happy' : b>=1 ? 'smile' : b===0 ? 'meh' : b>=-2 ? 'sad' : 'cry'; }
  var MOOD_TEXT = {happy:'Super happy!', smile:'Happy', meh:'Even', sad:'A bit sad', cry:'Very sad'};
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
    face: function(m, s){ return pix(F[m] || F.meh, s || 4); },
    coin: function(s){ return pix(COIN, s || 3); },
    block: function(s){ return pix(BLOCK, s || 3); },
    cloud: function(s){ return pix(CLOUD, s || 6); },
    rain: function(s){ return pix(RAIN, s || 4); },
    mood: mood, moodText: function(m){ return MOOD_TEXT[m] || ''; },
    sfx: sfx, unlock: function(){ ac(); },
    isMuted: function(){ return muted; },
    setMuted: function(v){ muted = !!v; try{ localStorage.setItem('daybook-kids-mute', muted ? '1' : '0'); }catch(_){} }
  };
})();
