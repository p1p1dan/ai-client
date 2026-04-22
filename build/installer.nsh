; Custom NSIS script for AiClient
; Register aiclient:// URL scheme

!macro customInstall
  ; Register URL protocol
  WriteRegStr HKCU "Software\Classes\aiclient" "" "URL:AiClient Protocol"
  WriteRegStr HKCU "Software\Classes\aiclient" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\aiclient\shell\open\command" "" '"$INSTDIR\AiClient.exe" "%1"'
!macroend

!macro customUnInstall
  ; Remove URL protocol registration
  DeleteRegKey HKCU "Software\Classes\aiclient"
!macroend
