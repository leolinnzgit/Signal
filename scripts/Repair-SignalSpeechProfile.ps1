param(
    [string]$ApplicationPool = 'SignalAppPool',
    [string]$ResultPath = (Join-Path $PSScriptRoot '../work/headline-audio-profile-repair.json'),
    [ValidateSet('ReadWrite', 'FullControl')]
    [string]$Permission = 'ReadWrite',
    [switch]$VerifyProductionAudio
)

$ErrorActionPreference = 'Stop'
Start-Transcript -LiteralPath ($ResultPath + '.log') -Force | Out-Null
$principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this one-time speech profile repair from an elevated Windows PowerShell.'
}

Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SignalSpeechPrivileges {
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid value);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TokenPrivileges privileges, uint length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static void Enable(string name) {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            Luid value;
            if (!LookupPrivilegeValue(null, name, out value)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var privileges = new TokenPrivileges { Count=1, Luid=value, Attributes=2 };
            if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var error = Marshal.GetLastWin32Error();
            if (error != 0) throw new Win32Exception(error);
        } finally { CloseHandle(token); }
    }
}
'@

$poolIdentity = [Security.Principal.NTAccount]::new("IIS APPPOOL\$ApplicationPool")
$poolSid = $poolIdentity.Translate([Security.Principal.SecurityIdentifier])
$keyPath = "$($poolSid.Value)\SOFTWARE\Microsoft\Speech_OneCore\Isolated"
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users, [Microsoft.Win32.RegistryView]::Default)
$key = $null
$originalSecurity = $null
$ownershipChanged = $false
$permissionChanged = $false
try {
    [SignalSpeechPrivileges]::Enable('SeTakeOwnershipPrivilege')
    [SignalSpeechPrivileges]::Enable('SeRestorePrivilege')
    $key = $registry.OpenSubKey($keyPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Security.AccessControl.RegistryRights]::ReadPermissions -bor [Security.AccessControl.RegistryRights]::TakeOwnership)
    if ($null -eq $key) { throw "The loaded speech profile key for $ApplicationPool is missing. Start Signal first." }
    $originalSecurity = $key.GetAccessControl()
    $originalSddl = $originalSecurity.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group)
    $backupSddl = $originalSddl
    if (Test-Path -LiteralPath $ResultPath) {
        $previousResult = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
        if ($previousResult.KeyPath -eq "HKEY_USERS\$keyPath" -and $previousResult.OriginalSecurity) { $backupSddl = $previousResult.OriginalSecurity }
    }
    # Save the original descriptor before the first mutation. Keep all existing rules.
    [pscustomobject]@{ Succeeded=$false; KeyPath="HKEY_USERS\$keyPath"; Account=$poolIdentity.Value; OriginalSecurity=$backupSddl; BeforeAttemptSecurity=$originalSddl; CompletedAt=[DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    $ownerSecurity = [Security.AccessControl.RegistrySecurity]::new()
    $ownerSecurity.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    $key.SetAccessControl($ownerSecurity)
    $ownershipChanged = $true
    $key.Dispose()
    $key = $registry.OpenSubKey($keyPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Security.AccessControl.RegistryRights]::ReadPermissions -bor [Security.AccessControl.RegistryRights]::ChangePermissions -bor [Security.AccessControl.RegistryRights]::TakeOwnership)
    $security = $key.GetAccessControl()
    $rights = if ($Permission -eq 'FullControl') { [Security.AccessControl.RegistryRights]::FullControl } else { [Security.AccessControl.RegistryRights]::ReadKey -bor [Security.AccessControl.RegistryRights]::WriteKey }
    $rule = [Security.AccessControl.RegistryAccessRule]::new($poolSid, $rights, [Security.AccessControl.InheritanceFlags]::ContainerInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    $security.SetOwner($originalSecurity.GetOwner([Security.Principal.SecurityIdentifier]))
    $key.SetAccessControl($security)
    $ownershipChanged = $false
    $permissionChanged = $true
    if ($VerifyProductionAudio) {
        $verificationStarted = [DateTimeOffset]::UtcNow
        & "$env:windir\System32\inetsrv\appcmd.exe" recycle apppool "/apppool.name:$ApplicationPool"
        if ($LASTEXITCODE -ne 0) { throw 'Could not restart the specified Signal application pool for verification.' }
        & "$env:windir\System32\curl.exe" --insecure --silent --fail --output NUL --max-time 30 https://localhost:8443/
        if ($LASTEXITCODE -ne 0) { throw 'Signal did not respond after restarting its application pool.' }
        $healthPath = 'C:\inetpub\Signal\App_Data\headline-audio-health.json'
        $verificationDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
        $audioPassed = $false
        while ([DateTimeOffset]::UtcNow -lt $verificationDeadline) {
            $health = Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json
            if ([DateTimeOffset]::Parse($health.CompletedAt) -ge $verificationStarted) {
                if (-not $health.Succeeded) { throw ('Production audio verification failed: ' + $health.Error) }
                $audioPassed = $true
                break
            }
            Start-Sleep -Seconds 1
        }
        if (-not $audioPassed) { throw 'Production audio verification did not finish in time.' }
    }
    [pscustomobject]@{ Succeeded=$true; KeyPath="HKEY_USERS\$keyPath"; Account=$poolIdentity.Value; OriginalSecurity=$backupSddl; BeforeAttemptSecurity=$originalSddl; Permission=$Permission; AudioVerified=[bool]$VerifyProductionAudio; CompletedAt=[DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    $permissionChanged = $false
} catch {
    $failure = $_.Exception.ToString()
    if ($permissionChanged) { $key.SetAccessControl($originalSecurity); $permissionChanged = $false }
    [pscustomobject]@{ Succeeded=$false; KeyPath="HKEY_USERS\$keyPath"; Account=$poolIdentity.Value; OriginalSecurity=$backupSddl; BeforeAttemptSecurity=$originalSddl; RolledBack=$true; Error=$failure; CompletedAt=[DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    throw
} finally {
    if ($ownershipChanged -and $null -ne $key -and $null -ne $originalSecurity) { $key.SetAccessControl($originalSecurity) }
    if ($null -ne $key) { $key.Dispose() }
    $registry.Dispose()
}
