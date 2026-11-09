"""Start a named local session, reusing its live socket and the shared proxy."""
import fcntl,json,os,pathlib,socket,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parent.parent
RUNTIME=ROOT/'.npm'
name=sys.argv[1] if len(sys.argv)>1 and not sys.argv[1].startswith('--') else 'LLMBot'
if not name.isascii() or not name.replace('_','').isalnum() or len(name)>16:raise SystemExit('Invalid bot username')
key=name.lower(); sock=RUNTIME/(key+'-control.sock')
lock=RUNTIME/('start-'+key+'.lock');lock.touch(mode=0o600,exist_ok=True)
with lock.open('r+') as guard:
 fcntl.flock(guard,fcntl.LOCK_EX)
 if sock.exists():
  try:
   with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
    connection.settimeout(8);connection.connect(str(sock));connection.sendall(b'{"action":"status"}\n');raw=b''
    while chunk:=connection.recv(65536):raw+=chunk
   print(raw.decode(),end='');raise SystemExit(0)
  except (ConnectionRefusedError,FileNotFoundError):sock.unlink(missing_ok=True)
 maintenance=RUNTIME/'runtime'/'maintenance.json'
 if maintenance.exists() and json.loads(maintenance.read_text()).get('untilUnix',0)>time.time():
  raise SystemExit('Scheduled maintenance is active; retry after the current service migration finishes')
 log=RUNTIME/('mcp-session.log' if key=='llmbot' else key+'-session.log')
 with log.open('ab') as output:
  process=subprocess.Popen(['/Users/xiaqingbo/.nvm/versions/node/v26.13.0/bin/node',str(ROOT/'scripts/session-service.mjs'),name],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
 deadline=time.monotonic()+40
 while time.monotonic()<deadline:
  if process.poll() is not None:raise SystemExit('Session exited; inspect '+str(log))
  if sock.exists():print(json.dumps({'started':True,'pid':process.pid,'username':name,'socket':str(sock)}));break
  time.sleep(.2)
 else:raise SystemExit('Session startup timed out; inspect the running process before retrying')
