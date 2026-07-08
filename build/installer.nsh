!macro preInit
  ; K-Tube 실행 중이면 종료 안내 후 자동 종료
  FindWindow $0 "" "K-Tube"
  IntCmp $0 0 done
    MessageBox MB_OK "K-Tube가 실행 중입니다.$\n종료 후 설치를 계속합니다."
    nsExec::ExecToLog 'taskkill /f /im "K-Tube.exe"'
    Sleep 1000
  done:
!macroend
