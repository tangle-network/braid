// @derived-from https://github.com/dotnet/aspire
// @source-commit be77aa36daf995fae0e72091141410c7082fcba3
// @source-path src/Aspire.Cli/Processes/WindowsConsoleProcessJob.cs and WindowsProcessInterop.cs
// @source-license MIT, Copyright (c) .NET Foundation and contributors
export const WINDOWS_JOB_HOST_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BraidWindowsJobHost
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint JOB_OBJECT_TERMINATE = 0x0008;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_OBJECT_0 = 0;
    private const int CleanupFailureExitCode = 125;
    private const int CleanupTimeoutMilliseconds = 5000;
    private static readonly IntPtr ProcThreadAttributeJobList = new IntPtr(0x0002000D);

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint desiredAccess, bool inheritHandle, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    public static int Main(string[] arguments)
    {
        if (arguments.Length >= 4 && arguments[0] == "--run")
        {
            string[] targetArguments = new string[arguments.Length - 3];
            Array.Copy(arguments, 3, targetArguments, 0, targetArguments.Length);
            return Run(arguments[1], arguments[2], targetArguments);
        }
        if (arguments.Length == 2 && arguments[0] == "--terminate")
            return Terminate(arguments[1]);
        Console.Error.WriteLine("BRAID_JOB_HOST_ERROR invalid invocation");
        return CleanupFailureExitCode;
    }

    private static int Run(string jobName, string markerPath, string[] arguments)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try
        {
            job = CreateJobObject(IntPtr.Zero, jobName);
            if (job == IntPtr.Zero)
                return Fail("CreateJobObject");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                return Fail("SetInformationJobObject");

            if (!PrepareJobAttribute(job, out attributeList, out jobList))
                return CleanupFailureExitCode;

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = GetStdHandle(-10);
            startup.StartupInfo.hStdOutput = GetStdHandle(-11);
            startup.StartupInfo.hStdError = GetStdHandle(-12);
            startup.lpAttributeList = attributeList;
            StringBuilder commandLine = BuildCommandLine(arguments);
            if (!CreateProcess(
                    arguments[0],
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero,
                    Environment.CurrentDirectory,
                    ref startup,
                    out process))
                return Fail("CreateProcess");

            if (ResumeThread(process.hThread) == 0xffffffff)
            {
                Fail("ResumeThread");
                TerminateJobObject(job, CleanupFailureExitCode);
                return CleanupFailureExitCode;
            }
            if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0)
                return Fail("WaitForSingleObject(process)");

            uint targetExitCode;
            if (!GetExitCodeProcess(process.hProcess, out targetExitCode))
                return Fail("GetExitCodeProcess");
            if (!DrainJob(job))
                return CleanupFailureExitCode;
            try
            {
                File.WriteAllText(markerPath, "drained");
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("BRAID_JOB_HOST_ERROR drain receipt: " + error.Message);
                return CleanupFailureExitCode;
            }
            return unchecked((int)targetExitCode);
        }
        finally
        {
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (jobList != IntPtr.Zero)
                Marshal.FreeHGlobal(jobList);
            if (process.hThread != IntPtr.Zero)
                CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero)
                CloseHandle(process.hProcess);
            if (job != IntPtr.Zero)
                CloseHandle(job);
        }
    }

    private static int Terminate(string jobName)
    {
        IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, jobName);
        if (job == IntPtr.Zero)
            return Fail("OpenJobObject");
        try
        {
            return DrainJob(job) ? 0 : CleanupFailureExitCode;
        }
        finally
        {
            CloseHandle(job);
        }
    }

    private static bool PrepareJobAttribute(
        IntPtr job,
        out IntPtr attributeList,
        out IntPtr jobList)
    {
        attributeList = IntPtr.Zero;
        jobList = IntPtr.Zero;
        IntPtr attributeListSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
        if (attributeListSize == IntPtr.Zero)
        {
            Fail("InitializeProcThreadAttributeList(size)");
            return false;
        }
        IntPtr candidateAttributeList = IntPtr.Zero;
        IntPtr candidateJobList = IntPtr.Zero;
        bool initialized = false;
        bool accepted = false;
        try
        {
            candidateAttributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(
                    candidateAttributeList,
                    1,
                    0,
                    ref attributeListSize))
            {
                Fail("InitializeProcThreadAttributeList");
                return false;
            }
            initialized = true;
            candidateJobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(candidateJobList, job);
            if (!UpdateProcThreadAttribute(
                    candidateAttributeList,
                    0,
                    ProcThreadAttributeJobList,
                    candidateJobList,
                    new IntPtr(IntPtr.Size),
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                Fail("UpdateProcThreadAttribute(job)");
                return false;
            }
            attributeList = candidateAttributeList;
            jobList = candidateJobList;
            accepted = true;
            return true;
        }
        finally
        {
            if (!accepted)
            {
                if (initialized)
                    DeleteProcThreadAttributeList(candidateAttributeList);
                if (candidateAttributeList != IntPtr.Zero)
                    Marshal.FreeHGlobal(candidateAttributeList);
                if (candidateJobList != IntPtr.Zero)
                    Marshal.FreeHGlobal(candidateJobList);
            }
        }
    }

    private static bool DrainJob(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
            new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        if (!QueryAccounting(job, ref accounting))
            return false;
        if (accounting.ActiveProcesses == 0)
            return true;
        if (!TerminateJobObject(job, CleanupFailureExitCode))
        {
            Fail("TerminateJobObject");
            return false;
        }

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(CleanupTimeoutMilliseconds);
        while (DateTime.UtcNow < deadline)
        {
            accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            if (!QueryAccounting(job, ref accounting))
                return false;
            if (accounting.ActiveProcesses == 0)
                return true;
            Thread.Sleep(10);
        }
        Console.Error.WriteLine("BRAID_JOB_HOST_ERROR cleanup timeout");
        return false;
    }

    private static bool QueryAccounting(
        IntPtr job,
        ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting)
    {
        if (QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                ref accounting,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                IntPtr.Zero))
            return true;
        Fail("QueryInformationJobObject");
        return false;
    }

    private static int Fail(string operation)
    {
        int code = Marshal.GetLastWin32Error();
        Console.Error.WriteLine(
            "BRAID_JOB_HOST_ERROR " + operation + " " + code + ": " +
            new Win32Exception(code).Message);
        return CleanupFailureExitCode;
    }

    private static StringBuilder BuildCommandLine(string[] arguments)
    {
        StringBuilder commandLine = new StringBuilder();
        for (int index = 0; index < arguments.Length; index++)
        {
            if (index > 0)
                commandLine.Append(' ');
            AppendQuoted(commandLine, arguments[index]);
        }
        return commandLine;
    }

    private static void AppendQuoted(StringBuilder output, string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
        {
            output.Append(value);
            return;
        }

        output.Append('"');
        int backslashes = 0;
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                output.Append('\\', backslashes * 2 + 1);
                output.Append('"');
                backslashes = 0;
                continue;
            }
            output.Append('\\', backslashes);
            backslashes = 0;
            output.Append(character);
        }
        output.Append('\\', backslashes * 2);
        output.Append('"');
    }
}
`
