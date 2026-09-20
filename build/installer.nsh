; Custom NSIS script for PiLab Ai
; Register aiclient:// URL scheme
; The executable name must match `win.executableName` in electron-builder.yml.

!macro customInstall
  ; Register URL protocol
  WriteRegStr HKCU "Software\Classes\aiclient" "" "URL:PiLab Ai Protocol"
  WriteRegStr HKCU "Software\Classes\aiclient" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\aiclient\shell\open\command" "" '"$INSTDIR\PiLabAi.exe" "%1"'
!macroend

!macro customUnInstall
  ; Remove URL protocol registration
  DeleteRegKey HKCU "Software\Classes\aiclient"
!macroend
