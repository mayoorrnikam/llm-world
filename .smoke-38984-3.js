
/* Surprise me.
   A database you can only query is a database you have to already have a
   question about. This is the way in for a reader who does not — one click,
   another record, keep going.
   The id list is fetched lazily ON CLICK rather than inlined into all 169 model
   pages, and the current record is excluded so the button never appears to do
   nothing. */
addEventListener('DOMContentLoaded',function(){
  var b=document.getElementById('surprise');if(!b)return;
  b.hidden=false;
  b.addEventListener('click',function(){
    b.disabled=true;
    fetch('../../data/llm-releases.json',{cache:'force-cache'})
      .then(function(r){return r.json();})
      .then(function(d){
        var here=location.pathname.replace(/\/$/,'').split('/').pop();
        var ids=d.releases.map(function(r){return r.id;}).filter(function(id){return id!==here;});
        if(!ids.length){b.disabled=false;return;}
        location.href='../../models/'+ids[Math.floor(Math.random()*ids.length)]+'/';
      })
      .catch(function(){b.disabled=false;b.textContent='Could not load';});
  });
});
