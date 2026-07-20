!macro preInit
  ; K-Music에서 검증된 패턴 그대로 이식 — FindWindow(창 제목 기반)는 트레이 상주 시 못 잡는
  ; 문제가 있어서 tasklist 기반으로 교체, MB_YESNO로 형이 직접 확인 후 진행하게 함(2026-07-20)
  nsExec::ExecToStack 'cmd /c tasklist /fi "imagename eq K-Tube.exe" | find /i "K-Tube.exe"'
  Pop $0
  StrCmp $0 "0" 0 done
    MessageBox MB_YESNO|MB_ICONQUESTION "K-Tube가 실행 중입니다.$\n종료하고 설치를 계속하시겠습니까?" IDYES closeit
    Abort
    closeit:
      nsExec::ExecToLog 'taskkill /f /im "K-Tube.exe"'
      StrCpy $1 0
      waitloop:
        Sleep 500
        IntOp $1 $1 + 1
        nsExec::ExecToStack 'cmd /c tasklist /fi "imagename eq K-Tube.exe" | find /i "K-Tube.exe"'
        Pop $2
        StrCmp $2 "0" checkmax waitdone
        checkmax:
          IntCmp $1 10 waitdone waitloop waitdone
      waitdone:
  done:
!macroend

!macro customUnInstall
  ; 새 버전 설치 중 기존 버전을 자동으로 지우는 내부 단계(silent)에서는 묻지 않고 자동으로
  ; 삭제 안 함 처리, 형이 Windows 설정에서 직접 "제거"할 때만 진짜로 물어봄(K-Music과 동일 원리)
  IfSilent keepdata
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "애플리케이션 데이터(설정, API 키, 관심 주제 등)도 함께 삭제하시겠습니까?" IDNO keepdata
    RMDir /r "$APPDATA\kris-tube"
  keepdata:
!macroend
