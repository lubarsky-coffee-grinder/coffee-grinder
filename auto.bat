@echo off
::git pull
chcp 65001 >nul
set "PS_UTF8=[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;"

cd grinder
FOR /f "tokens=*" %%i IN ('fnm env --use-on-cd') DO CALL %%i
fnm use 24 2>nul
call npm i --loglevel=error
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set "RUN_TAG=%%i"
if not exist logs mkdir logs
set "RUN_LINKS_FILE=logs\run-links-%RUN_TAG%.txt"
set "RUN_LINKS_LATEST=logs\run-links-latest.txt"
set "AUTO_ARCHIVE_URL=https://drive.google.com/drive/folders/17OlCbhRNhkLYSL6aKYMAr_d2oazw_RaX"
echo RUN_TAG=%RUN_TAG%
echo RUN_LINKS_FILE=%RUN_LINKS_FILE%
echo RUN_LINKS_LATEST=%RUN_LINKS_LATEST%
echo ARCHIVE_FOLDER=%AUTO_ARCHIVE_URL%

powershell -NoProfile -Command "%PS_UTF8% npm run cleanup auto 2>&1 | Tee-Object -FilePath 'logs/cleanup.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
del ..\audio\*.mp3 >nul 2>&1
del ..\img\*.jpg >nul 2>&1
del ..\img\screenshots.txt >nul 2>&1
del articles\*.txt >nul 2>&1
del articles\*.html >nul 2>&1


::call npm run load auto > logs/load.log
powershell -NoProfile -Command "%PS_UTF8% npm run summarize auto 2>&1 | Tee-Object -FilePath 'logs/summarize.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
powershell -NoProfile -Command "%PS_UTF8% npm run slides auto 2>&1 | Tee-Object -FilePath 'logs/slides.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"

powershell -NoProfile -Command "%PS_UTF8% npm run screenshots 2>&1 | Tee-Object -FilePath 'logs/screenshots.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
powershell -NoProfile -Command "%PS_UTF8% npm run upload-img auto 2>&1 | Tee-Object -FilePath 'logs/upload-img.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
powershell -NoProfile -Command "%PS_UTF8% npm run audio auto 2>&1 | Tee-Object -FilePath 'logs/audio.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"

echo.
echo RUN_COMPLETE
echo LINKS_FILE=%RUN_LINKS_FILE%
echo LINKS_LATEST=%RUN_LINKS_LATEST%
echo ARCHIVE_FOLDER=%AUTO_ARCHIVE_URL%
if exist "%RUN_LINKS_FILE%" (
	echo.
	echo ===== RUN LINKS =====
	type "%RUN_LINKS_FILE%"
)
