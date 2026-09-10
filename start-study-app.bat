@echo off
title StudyStreak Pro - Local Server
echo ========================================================
echo   StudyStreak Pro - הפעלת שרת מקומי למחשב
echo ========================================================
echo   פותח את האפליקציה בדפדפן בכתובת http://localhost:8000
echo   להפסקת השרת, פשוט סגור חלון זה.
echo ========================================================
start http://localhost:8000
python -m http.server 8000