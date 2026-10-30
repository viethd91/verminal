!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Verminal"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Verminal"
  ${endIf}
!macroend
