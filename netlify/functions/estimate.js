exports.handler = async (event) => {
  const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
  if (event.httpMethod==='OPTIONS') return {statusCode:204,headers:cors,body:''};
  try {
    const body = JSON.parse(event.body||'{}');
    const r = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:body.model||'claude-sonnet-4-6',max_tokens:body.max_tokens||1000,messages:body.messages,system:body.system||undefined})});
    const data = await r.json();
    return {statusCode:200,headers:{...cors,'Content-Type':'application/json'},body:JSON.stringify(data)};
  } catch(e) {
    return {statusCode:500,headers:{...cors,'Content-Type':'application/json'},body:JSON.stringify({error:e.message})};
  }
};
