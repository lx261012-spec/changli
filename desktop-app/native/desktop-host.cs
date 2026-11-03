using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Accessibility;

public static class DesktopHost {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string c,string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p,IntPtr a,string c,string n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f,IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr r);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h,int n);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h,int n,IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int n);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h,ref POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool SystemParametersInfo(uint a,uint p,StringBuilder b,uint f);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromPoint(POINT p,[MarshalAs(UnmanagedType.Interface)] out IAccessible a,[MarshalAs(UnmanagedType.Struct)] out object child);
  static string Class(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,256); return b.ToString(); }
  static bool DesktopClass(string c) { return c=="Progman" || c=="WorkerW" || c=="SHELLDLL_DefView" || c=="SysListView32"; }
  public static string Wallpaper() { var b=new StringBuilder(32768); if(!SystemParametersInfo(0x73,32768,b,0)) throw new Exception("无法读取原壁纸"); return b.ToString(); }
  public static string Probe(int x,int y) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    POINT p=new POINT{x=x,y=y};IntPtr target=WindowFromPoint(p), root=GetAncestor(target,2);
    return "{\"target\":\""+target.ToInt64()+"\",\"root\":\""+root.ToInt64()+"\",\"class\":\""+Class(target)+"\",\"blankDesktop\":"+(IsBlankDesktop(p,target)?"true":"false")+"}";
  }
  public static string Inspect(long value) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    RECT r;IntPtr h=new IntPtr(value);GetWindowRect(h,out r);
    return "{\"left\":"+r.left+",\"top\":"+r.top+",\"right\":"+r.right+",\"bottom\":"+r.bottom+",\"style\":\""+GetWindowLongPtr(h,-16).ToInt64()+"\",\"extendedStyle\":\""+GetWindowLongPtr(h,-20).ToInt64()+"\"}";
  }
  static IntPtr Worker() {
    IntPtr prog=FindWindow("Progman",null), r;
    if(prog==IntPtr.Zero) throw new Exception("找不到Windows桌面");
    SendMessageTimeout(prog,0x052c,new IntPtr(0xD),new IntPtr(1),2,1200,out r);
    SendMessageTimeout(prog,0x052c,IntPtr.Zero,IntPtr.Zero,2,1200,out r);
    IntPtr worker=IntPtr.Zero;
    EnumWindows(delegate(IntPtr h,IntPtr l) {
      if(FindWindowEx(h,IntPtr.Zero,"SHELLDLL_DefView",null)!=IntPtr.Zero) {
        worker=FindWindowEx(IntPtr.Zero,h,"WorkerW",null);
        if(worker==IntPtr.Zero) worker=FindWindowEx(prog,IntPtr.Zero,"WorkerW",null);
      }
      return worker==IntPtr.Zero;
    },IntPtr.Zero);
    if(worker==IntPtr.Zero || FindWindowEx(worker,IntPtr.Zero,"SHELLDLL_DefView",null)!=IntPtr.Zero) throw new Exception("Windows未提供可用的图标后壁纸层");
    return worker;
  }
  static bool IsBlankDesktop(POINT p,IntPtr target) {
    string c=Class(target);
    if(!DesktopClass(c)) return false;
    if(c!="SysListView32") return true;
    IAccessible acc=null; object child=null;
    try {
      if(AccessibleObjectFromPoint(p,out acc,out child)!=0 || acc==null) return false;
      int role=Convert.ToInt32(acc.get_accRole(child));
      return role==33 || role==10 || role==9; // List, client or window, never list item/icon.
    } catch { return false; }
    finally { if(acc!=null) Marshal.ReleaseComObject(acc); }
  }
  public static void Run(long value,int parentPid) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    IntPtr h=new IntPtr(value), worker=Worker();
    if(!IsWindow(h)) throw new Exception("壁纸窗口已失效");
    long style=GetWindowLongPtr(h,-16).ToInt64();
    SetWindowLongPtr(h,-16,new IntPtr((style & ~unchecked((long)0x80000000)) | 0x40000000));
    SetParent(h,worker);
    if(GetParent(h)!=worker) throw new Exception("未能将壁纸嵌入Windows桌面");
    POINT origin=new POINT {x=GetSystemMetrics(76),y=GetSystemMetrics(77)};
    ScreenToClient(worker,ref origin);
    if(!SetWindowPos(h,IntPtr.Zero,origin.x,origin.y,GetSystemMetrics(78),GetSystemMetrics(79),0x0030)) throw new Exception("壁纸尺寸设置失败");
    Console.WriteLine("{\"type\":\"attached\",\"parent\":\""+worker.ToInt64()+"\",\"verified\":true}");
    bool wasDown=false;
    using(var parent=Process.GetProcessById(parentPid)) {
      while(!parent.HasExited && IsWindow(h)) {
        POINT p; GetCursorPos(out p);
        bool down=(GetAsyncKeyState(1)&0x8000)!=0;
        IntPtr target=WindowFromPoint(p);
        bool desktop=DesktopClass(Class(GetForegroundWindow())) && DesktopClass(Class(target));
        bool click=desktop && down && !wasDown && IsBlankDesktop(p,target);
        Console.WriteLine("{\"type\":\"wallpaper-pointer\",\"x\":"+p.x+",\"y\":"+p.y+",\"active\":"+(desktop?"true":"false")+",\"click\":"+(click?"true":"false")+"}");
        wasDown=down;
        Thread.Sleep(50);
      }
    }
  }
}
