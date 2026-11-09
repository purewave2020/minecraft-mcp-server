if(-not ('MinecraftRollingLog' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.IO;
public sealed class MinecraftRollingLog : Stream {
  readonly string path; readonly long maximum; readonly int keep; FileStream file; readonly object gate=new object();
  public MinecraftRollingLog(string path,long maximum,int keep){this.path=path;this.maximum=maximum;this.keep=keep;Open();}
  void Open(){file=new FileStream(path,FileMode.Append,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete);}
  public override void Write(byte[] buffer,int offset,int count){lock(gate){if(file.Length+count>maximum){file.Dispose();for(int i=keep-1;i>=1;i--){string dest=path+"."+(i+1);if(File.Exists(dest))File.Delete(dest);if(File.Exists(path+"."+i))File.Move(path+"."+i,dest);}if(File.Exists(path+".1"))File.Delete(path+".1");if(File.Exists(path))File.Move(path,path+".1");Open();}file.Write(buffer,offset,count);file.Flush();}}
  public override void Flush(){lock(gate){file.Flush();}}
  protected override void Dispose(bool disposing){if(disposing){lock(gate){file.Dispose();}}base.Dispose(disposing);}
  public override bool CanRead{get{return false;}}public override bool CanSeek{get{return false;}}public override bool CanWrite{get{return true;}}
  public override long Length{get{return file.Length;}}public override long Position{get{return file.Position;}set{throw new NotSupportedException();}}
  public override int Read(byte[] b,int o,int c){throw new NotSupportedException();}public override long Seek(long o,SeekOrigin s){throw new NotSupportedException();}public override void SetLength(long v){throw new NotSupportedException();}
}
'@
}
