; Custom NSIS script for AI client
; Register enso:// URL scheme

!macro customInstall
  ; Register URL protocol
  WriteRegStr HKCU "Software\Classes\enso" "" "URL:AI client Protocol"
  WriteRegStr HKCU "Software\Classes\enso" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\enso\shell\open\command" "" '"$INSTDIR\AI client.exe" "%1"'
!macroend

!macro customUnInstall
  ; Remove URL protocol registration
  DeleteRegKey HKCU "Software\Classes\enso"
!macroend
