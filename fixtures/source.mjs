import { listen } from '../src/http.mjs';
export async function startFixture(){let version=1;return listen(async url=>{
  if(url.pathname==='/advance'){version++;return {body:{version}};}
  if(url.pathname==='/studies/1/instances'){const ids=version>1?['1.1.1','1.1.2']:['1.1.1'];return {headers:{etag:'"study-'+version+'"'},body:ids.map(id=>({'0020000D':{vr:'UI',Value:['1']},'0020000E':{vr:'UI',Value:['1.1']},'00080018':{vr:'UI',Value:[id]},'00280008':{vr:'IS',Value:[2]},'7FE00010':{vr:'OB',BulkDataURI:'/bulk/'+id}}))};}
  if(url.pathname.startsWith('/bulk/'))return {type:'application/octet-stream',body:Buffer.from([1,2,3,4]),headers:{etag:'"raw-1"'}};
  if(url.pathname==='/instances/1.1.1/frames/1,2'){const body=Buffer.from('--frames\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nContent-Location: /instances/1.1.1/frames/2\r\nContent-ID: <frame-2>\r\n\r\nBB\r\n--frames\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nContent-Location: /instances/1.1.1/frames/1\r\nContent-ID: <frame-1>\r\n\r\nAA\r\n--frames--\r\n');return {type:'multipart/related; type="application/octet-stream"; boundary=frames',body};}
  return {status:404,body:{error:'资源不存在'}};
});}
