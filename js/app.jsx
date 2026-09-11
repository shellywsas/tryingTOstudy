

const { useState, useEffect, useMemo, useRef } = React;


function App() {
            const [globalState, setGlobalState] = useState(() => {
                const saved = localStorage.getItem('studyStreakData_DB_v7');
                if (saved) {
                    try {
                        const parsed = JSON.parse(saved);
                        if (parsed && parsed.users) {
                            Object.keys(parsed.users).forEach(u => {
                                if (parsed.users[u] && parsed.users[u].tasks) {
                                    parsed.users[u].tasks = parsed.users[u].tasks.map(t => {
                                        if (t.isLessonLog && t.understandingRating) {
                                            return { ...t, understandingRating: null };
                                        }
                                        return t;
                                    });
                                }
                            });
                        }
                        return parsed;
                    } catch(e) { return { users: {}, activeUser: null }; }
                }
                return { users: {}, activeUser: null };
            });
            const pendingWriteSync = useRef(0);


            useEffect(() => {
                localStorage.setItem('studyStreakData_DB_v7', JSON.stringify(globalState));
            }, [globalState]);


            useEffect(() => {
                if (!globalState.activeUser || !db) return;


                const userRef = db.collection("users").doc(globalState.activeUser);
                
                const unsubscribe = userRef.onSnapshot((doc) => {
                    if (doc.exists) {
                        const liveData = doc.data();
                        
                        setGlobalState(prev => {
                            const currentUserData = prev.users[prev.activeUser];
                            const applied = applyRemoteUser(currentUserData, liveData, pendingWriteSync.current);
                            const healed = healCompletedFromHistory(applied || liveData);
                            if (currentUserData && JSON.stringify(currentUserData) === JSON.stringify(healed)) return prev;
                            return {
                                ...prev,
                                users: {
                                    ...prev.users,
                                    [prev.activeUser]: healed
                                }
                            };
                        });
                    }
                }, (error) => {
                    console.error("Live sync error:", error);
                });


                return () => unsubscribe();
            }, [globalState.activeUser]);


            const activeUserData = globalState.activeUser ? globalState.users[globalState.activeUser] : null;

            useEffect(() => {
                if (!activeUserData) return;
                const healed = healCompletedFromHistory(activeUserData);
                if (healed !== activeUserData) {
                    updateUserData(() => healed);
                }
            }, [globalState.activeUser]);


            const updateUserData = (updater) => {
                setGlobalState(prev => {
                    if (!prev.activeUser) return prev;
                    const user = prev.users[prev.activeUser];
                    const updatedUser = typeof updater === 'function' ? updater(user) : { ...user, ...updater };
                    if (updatedUser === user) return prev;
                    
                    updatedUser.lastSync = Date.now();
                    pendingWriteSync.current = updatedUser.lastSync;
                    
                    if (db) {
                        db.collection("users").doc(prev.activeUser).set(updatedUser, { merge: true })
                          .catch(err => console.error("Error saving to Firebase: ", err));
                    }


                    return {
                        ...prev,
                        users: {
                            ...prev.users,
                            [prev.activeUser]: updatedUser
                        }
                    };
                });
            };


            const checkAndAwardBadges = (userData) => {
                if(!userData) return userData;
                let newBadges = [...(userData.badges || [])];
                let earnedNew = false;
                
                const exam90PlusBadge = newBadges.find(b => b.id === 'b_exam_90');
                if (!exam90PlusBadge) {
                    const exams90PlusCount = (userData.exams || []).filter(e => e.grade && e.grade >= 90).length;
                    if (exams90PlusCount >= 4) {
                        newBadges.push({ id: 'b_exam_90', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('🏆 זכית בתג: מצטיינת מבחנים!', 'success');
                    }
                }
                
                const turboBadge = newBadges.find(b => b.id === 'b_weekly_20');
                if(!turboBadge) {
                    if (userData.highestWeeklyPoints >= 20 || userData.weeklyPoints >= 20) {
                        newBadges.push({ id: 'b_weekly_20', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('⚡ זכית בתג: טורבו!', 'success');
                    }
                }
                
                const onTimeBadge = newBadges.find(b => b.id === 'b_on_time');
                if(!onTimeBadge) {
                    if (userData.longestStreak >= 14) {
                        newBadges.push({ id: 'b_on_time', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('⏱️ זכית בתג: חסינת איחורים!', 'success');
                    }
                }


                if (earnedNew) {
                    return { ...userData, badges: newBadges };
                }
                return userData;
            };


            useEffect(() => {
                if (activeUserData) {
                    const now = new Date().getTime();
                    if (now > activeUserData.nextWeeklyReset) {
                        updateUserData(prev => ({
                            ...prev,
                            highestWeeklyPoints: Math.max(prev.highestWeeklyPoints || 0, prev.weeklyPoints),
                            weeklyPoints: 0,
                            nextWeeklyReset: getNextSaturdayNight()
                        }));
                    }
                }
            }, [globalState.activeUser, activeUserData?.nextWeeklyReset]);


            useEffect(() => {
                if (!globalState.activeUser) return;
                updateUserData(prev => {
                    if (!prev || !prev.tasks) return prev;
                    const now = new Date();
                    let shouldBreakStreak = false;
                    let oldestUncompletedDate = null;
                    let oldestUncompletedTaskId = null;
                    let needsUpdate = false;
                    let pointsToDeduct = 0;
                    let historyLogs = [];

                    const updatedTasks = prev.tasks.map(task => {
                        if (task.completed || task.isLessonLog || !task.dueDate || !task.dueTime) return task;
                        const dueDate = new Date(`${task.dueDate}T${task.dueTime}`);
                        if (now > dueDate && prev.taskStreak > 0) {
                            shouldBreakStreak = true;
                            if (!oldestUncompletedDate || dueDate < oldestUncompletedDate) {
                                oldestUncompletedDate = dueDate;
                                oldestUncompletedTaskId = task.id;
                            }
                        }
                        const hoursLate = (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60);
                        if (hoursLate >= 3 && !task.autoPenaltyApplied) {
                            needsUpdate = true;
                            pointsToDeduct += 2;
                            const sub = (prev.subjects || []).find(s => s.id === task.subjectId);
                            historyLogs.push({
                                id: 'ph_auto_' + task.id + '_' + Date.now(),
                                taskId: task.id,
                                taskTitle: task.title,
                                subjectName: sub ? sub.name : 'כללי',
                                subjectEmoji: sub ? sub.emoji : '📚',
                                points: -2,
                                date: now.toISOString(),
                                details: 'קנס אוטומטי! המשימה עברה את זמן ההגשה ביותר מ-3 שעות.'
                            });
                            return { ...task, autoPenaltyApplied: true };
                        }
                        return task;
                    });

                    if (!shouldBreakStreak && !needsUpdate) return prev;

                    let newStreakHistory = [...(prev.streakHistory || [])];
                    let taskStreak = prev.taskStreak;
                    let currentStreakStart = prev.currentStreakStart;
                    let currentStreakEmojis = prev.currentStreakEmojis;

                    if (shouldBreakStreak && taskStreak > 0) {
                        newStreakHistory.push({
                            id: 'sh_' + Date.now(),
                            startDate: currentStreakStart,
                            endDate: oldestUncompletedDate.toISOString(),
                            length: taskStreak,
                            emojis: [...(currentStreakEmojis || [])],
                            brokenByTaskId: oldestUncompletedTaskId
                        });
                        taskStreak = 0;
                        currentStreakStart = null;
                        currentStreakEmojis = [];
                        setTimeout(() => showToast('רצף ההגשות שלך נשבר כי זמן ההגשה של משימה עבר. 😢', 'warning'), 100);
                    }
                    if (needsUpdate) {
                        setTimeout(() => showToast(`משימה עברה את יעד ההגשה ביותר מ-3 שעות! ירדו 2 נקודות אוטומטית. ⏰`, 'error'), 600);
                    }
                    return {
                        ...prev,
                        tasks: updatedTasks,
                        totalPoints: prev.totalPoints - pointsToDeduct,
                        weeklyPoints: prev.weeklyPoints - pointsToDeduct,
                        pointsHistory: [...historyLogs, ...(prev.pointsHistory || [])],
                        taskStreak,
                        currentStreakStart,
                        currentStreakEmojis,
                        streakHistory: newStreakHistory
                    };
                });
            }, [globalState.activeUser, activeUserData?.tasks, activeUserData?.taskStreak]);


            const handleAddTaskToCalendar = (task) => {
                const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                const subjectName = sub ? sub.name : 'כללי';
                const title = `${task.title}`;
                const desc = `נושא: ${task.lessonTopic || 'לא צוין'}\\nנשמר דרך StudyStreak Pro ✨`;


                if (!task.dueDate) {
                    showToast('לא הוגדר תאריך למשימה זו! עדכני תאריך לפני הוספה ליומן.', 'warning');
                    return;
                }


                const dueDate = new Date(task.dueDate);
                let dueTimeStr = task.dueTime || '08:00';
                const [hours, minutes] = dueTimeStr.split(':').map(Number);
                dueDate.setHours(hours, minutes, 0);


                const formatICSDate = (date) => {
                    return date.toISOString().replace(/-|:/g, '').split('.')[0] + 'Z';
                };


                const dtstart = formatICSDate(dueDate);
                const endDate = new Date(dueDate.getTime() + 60 * 60 * 1000); 
                const dtend = formatICSDate(endDate);


                let alarms = '';
                const now = new Date();
                const daysUntil = Math.max(1, Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

                if (task.isExamPrep || title.includes('מבחן') || title.includes('מתכונת')) {
                    let examTargetDate = dueDate;
                    if (task.examId && activeUserData.exams) {
                        const relatedExam = activeUserData.exams.find(e => e.id === task.examId);
                        if (relatedExam) {
                             examTargetDate = new Date(relatedExam.date);
                        }
                    }
                    const examDaysUntil = Math.max(1, Math.floor((examTargetDate - now) / (1000 * 60 * 60 * 24)));
                    
                    for (let d = 2; d <= examDaysUntil + 1; d += 2) {
                        alarms += `\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:תזכורת למידה: עוד ${d} ימים לבחינה ב-${subjectName} (${title})!\nTRIGGER:-P${d}D\nEND:VALARM`;
                    }
                    if (examDaysUntil >= 1) {
                        alarms += `\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:מחר המבחן ב-${subjectName}! בהצלחה 🍀\nTRIGGER:-P1D\nEND:VALARM`;
                    }
                } else {
                    // Homework: reminders every 2 days leading up to due date
                    for (let d = 2; d <= daysUntil + 1; d += 2) {
                        alarms += `\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:תזכורת שיעורי בית: נותרו עוד ${d} ימים להגשת "${title}" ב-${subjectName}! כדאי להתקדם.\nTRIGGER:-P${d}D\nEND:VALARM`;
                    }
                    if (daysUntil >= 1) {
                        alarms += `\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:תזכורת: מחר מועד ההגשה של "${title}" ב-${subjectName}! נא לוודא שהכל מוכן.\nTRIGGER:-P1D\nEND:VALARM`;
                    }
                    // Day-of reminder 2 hours before deadline
                    alarms += `\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:דחוף! עוד שעתיים מועד ההגשה של "${title}" ב-${subjectName}!\nTRIGGER:-PT2H\nEND:VALARM`;
                }


                const icsContent = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//StudyStreak//HE\nCALSCALE:GREGORIAN\nBEGIN:VEVENT\nUID:${task.id}@studystreak.app\nDTSTAMP:${formatICSDate(new Date())}\nDTSTART:${dtstart}\nDTEND:${dtend}\nSUMMARY:${title} (${subjectName})\nDESCRIPTION:${desc}${alarms}\nEND:VEVENT\nEND:VCALENDAR`;


                const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
                const link = document.createElement('a');
                link.href = window.URL.createObjectURL(blob);
                link.setAttribute('download', `${title}.ics`);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);


                showToast('הקובץ ירד! כולל תזכורות אוטומטיות ליומן כל יומיים עד ההגשה 📅', 'success');
            };

            const sendToServiceWorker = (msg) => {
                if ('serviceWorker' in navigator) {
                    if (navigator.serviceWorker.controller) {
                        navigator.serviceWorker.controller.postMessage(msg);
                    } else if (navigator.serviceWorker.ready) {
                        navigator.serviceWorker.ready.then(reg => {
                            if (reg.active) reg.active.postMessage(msg);
                        });
                    }
                }
            };

            const testInstantNotification = () => {
                const isStandalone = (typeof window !== 'undefined') && (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);
                if (isIOSDevice && !isStandalone) {
                    setNotificationHelpTab('ios');
                    toggleModal('notificationHelp', true);
                    return;
                }

                if (!("Notification" in window)) {
                    toggleModal('notificationHelp', true);
                    return;
                }

                if (Notification.permission === 'denied') {
                    setNotificationHelpTab(isIOSDevice ? 'ios' : 'android');
                    toggleModal('notificationHelp', true);
                    return;
                }

                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        const testMsg = 'היי שלי! 🌸 זו התראת בדיקה של StudyStreak – ככה יקפצו לך תזכורות מעודדות על מסך הנעילה בזמנים הפנויים!';
                        const showSuccess = () => showToast('התראת בדיקה נשלחה! בדקי את מסך הנעילה או וילון ההתראות 🔔', 'success');

                        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                            navigator.serviceWorker.ready.then(reg => {
                                reg.showNotification('התראת בדיקה מוצלחת! ✨', {
                                    body: testMsg,
                                    icon: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%239333ea'%3E%3Cpath d='M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'/%3E%3C/svg%3E",
                                    vibrate: [250, 100, 250]
                                }).then(showSuccess).catch(() => {
                                    try {
                                        new Notification('התראת בדיקה מוצלחת! ✨', { body: testMsg });
                                        showSuccess();
                                    } catch(e) {}
                                });
                            });
                        } else {
                            try {
                                new Notification('התראת בדיקה מוצלחת! ✨', { body: testMsg });
                                showSuccess();
                            } catch (e) {
                                showToast('לא ניתן היה להציג התראה כעת בדפדפן', 'warning');
                            }
                        }
                    } else {
                        setNotificationHelpTab(isIOSDevice ? 'ios' : 'android');
                        toggleModal('notificationHelp', true);
                    }
                }).catch(err => {
                    setNotificationHelpTab(isIOSDevice ? 'ios' : 'android');
                    toggleModal('notificationHelp', true);
                });
            };

            const toggleSmartReminders = (task) => {
                const isCurrentlyActive = !!task.remindersEnabled;
                const sub = (activeUserData.subjects || []).find(s => s.id === task.subjectId);
                const subjectName = sub ? sub.name : 'כללי';
                const topic = task.lessonTopic || task.title;
                const userName = activeUserData.name || 'שלי';

                if (isCurrentlyActive) {
                    sendToServiceWorker({
                        type: 'CANCEL_TASK_REMINDERS',
                        taskId: task.id
                    });
                    updateUserData(prev => ({
                        ...prev,
                        tasks: (prev.tasks || []).map(t => t.id === task.id ? { ...t, remindersEnabled: false } : t)
                    }));
                    showToast(`תזכורות חכמות בוטלו עבור "${task.title}".`, 'info');
                    return;
                }

                const isStandalone = (typeof window !== 'undefined') && (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);
                if (isIOSDevice && !isStandalone) {
                    setNotificationHelpTab('ios');
                    toggleModal('notificationHelp', true);
                    return;
                }

                if (!("Notification" in window) || Notification.permission === 'denied') {
                    setNotificationHelpTab(isIOSDevice ? 'ios' : 'android');
                    toggleModal('notificationHelp', true);
                    return;
                }

                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        const freeWindows = getUpcomingFreeWindows(activeUserData.scheduleSettings, task.dueDate);
                        const windowsToSchedule = freeWindows.length > 0 ? freeWindows.slice(0, 4) : [
                            { dateStr: new Date().toISOString().split('T')[0], start: '16:30', end: '18:00', dayName: 'היום' },
                            { dateStr: new Date().toISOString().split('T')[0], start: '20:00', end: '21:30', dayName: 'הערב' }
                        ];

                        // 1. Send scheduled reminders for each upcoming free window
                        windowsToSchedule.forEach((win, index) => {
                            const randomMsg = getRandomMotivationalMessage(subjectName, task.title, topic, `${win.dayName} (${win.start} - ${win.end})`, userName);
                            let winTime = new Date(`${win.dateStr}T${win.start}`).getTime();
                            let delayMs = winTime - Date.now();
                            if (delayMs <= 0) {
                                delayMs = 60000 + (index * 180000);
                            }

                            sendToServiceWorker({
                                type: 'SCHEDULE_NOTIFICATION',
                                title: `תזכורת שיעורי בית: ${subjectName} 📚`,
                                body: randomMsg,
                                delayMs: delayMs,
                                tag: `task-${task.id}-win-${index}`,
                                taskId: task.id
                            });
                        });

                        // 2. Schedule a 15-second lock-screen test reminder so user can verify on mobile immediately
                        const demoSampleMsg = getRandomMotivationalMessage(subjectName, task.title, topic, 'הזמן הפנוי שלך', userName);
                        sendToServiceWorker({
                            type: 'SCHEDULE_NOTIFICATION',
                            title: `תזכורת חכמה: ${subjectName} ✨`,
                            body: demoSampleMsg,
                            delayMs: 15000,
                            tag: `task-${task.id}-demo-15s`,
                            taskId: task.id
                        });

                        updateUserData(prev => ({
                            ...prev,
                            tasks: (prev.tasks || []).map(t => t.id === task.id ? { ...t, remindersEnabled: true } : t)
                        }));

                        // 3. Immediate confirmation notification
                        const instantMsg = `התזכורות הופעלו! תזכורת לדוגמה תופיע בעוד 15 שניות, ובהמשך לפי הלו״ז הפנוי שלך 🌟`;
                        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                            navigator.serviceWorker.ready.then(reg => {
                                reg.showNotification(`תזכורות חכמות הופעלו: ${subjectName} 🚀`, {
                                    body: instantMsg,
                                    icon: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2310b981'%3E%3Cpath d='M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'/%3E%3C/svg%3E",
                                    vibrate: [200, 100, 200]
                                });
                            });
                        }

                        showToast(`תזכורות חכמות הופעלו! נשלח תזכורות מעודדות מגוונות בחלונות הפנויים עד ההגשה 🔔`, 'success');
                    } else {
                        showToast('כדי לקבל תזכורות במסך הנעילה, נא לאשר קבלת התראות בדפדפן', 'warning');
                    }
                });
            };

            const getWeeklyReportData = () => {
                if (!activeUserData) return null;
                const now = new Date();
                const startOfWeek = new Date(now);
                startOfWeek.setDate(now.getDate() - now.getDay());
                startOfWeek.setHours(0,0,0,0);
                
                const endOfWeek = new Date(startOfWeek);
                endOfWeek.setDate(startOfWeek.getDate() + 6);
                endOfWeek.setHours(23,59,59,999);

                const thisWeekTasks = (activeUserData.tasks || []).filter(t => {
                    if (!t.completedAt) return false;
                    const d = new Date(t.completedAt);
                    return d >= startOfWeek && d <= endOfWeek;
                });

                const completedHW = thisWeekTasks.filter(t => !t.givenUp && !t.isExamPrep && !t.isLessonLog);
                const givenUpHW = thisWeekTasks.filter(t => t.givenUp);
                const examPrepDone = thisWeekTasks.filter(t => !t.givenUp && t.isExamPrep);
                const lessonsLogged = thisWeekTasks.filter(t => t.isLessonLog);

                const thisWeekExams = (activeUserData.exams || []).filter(e => {
                    const d = new Date(e.date);
                    return d >= startOfWeek && d <= endOfWeek;
                });

                const thisWeekHistory = (activeUserData.pointsHistory || []).filter(h => {
                    const d = new Date(h.date);
                    return d >= startOfWeek && d <= endOfWeek;
                });

                const totalPointsGained = thisWeekHistory.filter(h => h.points > 0).reduce((acc, h) => acc + h.points, 0);

                return {
                    startDate: startOfWeek.toLocaleDateString('he-IL'),
                    endDate: endOfWeek.toLocaleDateString('he-IL'),
                    completedHW,
                    givenUpHW,
                    examPrepDone,
                    lessonsLogged,
                    thisWeekExams,
                    totalPointsGained
                };
            };

            const toggleWhatsAppTaskReminder = (task) => {
                const isCurrentlyActive = !!task.whatsappRemindersEnabled;
                const sub = (activeUserData.subjects || []).find(s => s.id === task.subjectId);
                const subjectName = sub ? sub.name : 'כללי';
                const userName = activeUserData.name || 'שלי';

                if (isCurrentlyActive) {
                    updateUserData(prev => ({
                        ...prev,
                        tasks: (prev.tasks || []).map(t => t.id === task.id ? { ...t, whatsappRemindersEnabled: false } : t)
                    }));
                    showToast(`תזכורות וואטסאפ בוטלו עבור "${task.title}".`, 'info');
                    return;
                }

                let phone = activeUserData.phoneNumber;
                if (!phone) {
                    phone = prompt('נא להזין מספר טלפון לקבלת תזכורות בוואטסאפ (לדוגמה: 0501234567):', '');
                    if (!phone) return;
                    updateUserData(prev => ({
                        ...prev,
                        phoneNumber: phone
                    }));
                }

                updateUserData(prev => ({
                    ...prev,
                    tasks: (prev.tasks || []).map(t => t.id === task.id ? { ...t, whatsappRemindersEnabled: true } : t)
                }));

                // בדיקת שעות בית ספר: אם התלמידה בבית ספר כרגע, לא שולחים הודעה שתפריע בשיעור!
                const now = new Date();
                const todayDay = now.getDay();
                const todayPlan = (activeUserData.scheduleSettings || []).find(s => s.day === todayDay);
                const schoolEndTime = todayPlan?.schoolEndTime;
                let isInSchoolNow = false;
                let schoolNoticeTime = '';

                if (schoolEndTime) {
                    const [endH, endM] = schoolEndTime.split(':').map(Number);
                    const schoolEndMinutes = endH * 60 + (endM || 0);
                    const reminderStartMinutes = Math.max(0, schoolEndMinutes - 30);
                    const nowMinutes = now.getHours() * 60 + now.getMinutes();

                    if (nowMinutes < reminderStartMinutes) {
                        isInSchoolNow = true;
                        const startH = Math.floor(reminderStartMinutes / 60);
                        const startM = reminderStartMinutes % 60;
                        schoolNoticeTime = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
                    }
                }

                if (isInSchoolNow) {
                    showToast(`תזכורות וואטסאפ הופעלו! 📚 כי את בבית ספר כעת, התזכורת הראשונה תישלח לקראת סיום הלימודים (ב-${schoolNoticeTime}).`, 'success');
                    return;
                }

                const reminderText = WhatsAppService.generateStudentReminderText({
                    studentName: userName,
                    subjectName: subjectName,
                    taskTitle: task.title,
                    dueDate: task.dueDate,
                    dueTime: task.dueTime,
                    freeSlotText: 'בזמן הפנוי שלך לפי הלו"ז'
                });

                WhatsAppService.sendMessage({
                    to: phone,
                    message: reminderText,
                    gatewayConfig: activeUserData.whatsappGateway
                }).then(res => {
                    if (res && res.status === 'sent_gateway') {
                        showToast(`תזכורת וואטסאפ הופעלה ונשלחה אוטומטית! 💬`, 'success');
                    } else {
                        showToast(`תזכורת וואטסאפ הופעלה בהצלחה! 💬`, 'success');
                    }
                }).catch(err => {
                    console.error('Error sending WhatsApp reminder:', err);
                    showToast('תזכורת וואטסאפ הופעלה', 'info');
                });
            };

            const getWeekIdentifier = (d = new Date()) => {
                const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
                date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
                const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
                const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
                return `${date.getUTCFullYear()}-W${weekNo}`;
            };

            const handleSendWhatsAppTest = (type = 'student') => {
                let targetPhone = '';
                let label = '';
                if (type === 'student' || type === false) {
                    targetPhone = activeUserData?.phoneNumber;
                    label = 'התלמידה';
                } else if (type === 'parent1' || type === true) {
                    targetPhone = activeUserData?.parentPhoneNumber;
                    label = 'הורה 1';
                } else if (type === 'parent2') {
                    targetPhone = activeUserData?.parentPhoneNumber2;
                    label = 'הורה 2';
                }

                if (!targetPhone) {
                    showToast(`נא להזין מספר טלפון עבור ${label} 📱`, 'warning');
                    return;
                }

                const isParent = type !== 'student' && type !== false;
                const testMsg = isParent 
                    ? `שלום מהאפליקציה StudyStreak Pro! ✨\nזהו מספר הטלפון המוגדר לקבלת עדכונים ודוחות התקדמות שבועיים של ${activeUserData.name || 'התלמיד/ה'}. נהדר לראות את ההשקעה וההתקדמות!`
                    : `היי ${activeUserData.name || 'אלופה'}! ✨\nבדיקת חיבור לוואטסאפ הצליחה! מכאן תקבלי תזכורות מוטיבציה שקטות וחכמות לשיעורי הבית לפי הלו"ז שלך 📚💪`;

                WhatsAppService.sendMessage({
                    to: targetPhone,
                    message: testMsg,
                    gatewayConfig: activeUserData.whatsappGateway
                }).then(res => {
                    if (res && res.status === 'sent_gateway') {
                        showToast(`הודעת בדיקה נשלחה ישירות לוואטסאפ של ${label}! 🚀`, 'success');
                    } else if (res && res.status === 'opened_link') {
                        showToast(`נפתח וואטסאפ לשליחת הודעת בדיקה ל-${label} 📲`, 'info');
                    }
                }).catch(err => {
                    console.error('Error sending test message:', err);
                    showToast('שגיאה בשליחה לוואטסאפ', 'error');
                });
            };

            const handleSendParentWeeklyReportWhatsApp = (silent = false) => {
                const p1 = activeUserData?.parentPhoneNumber?.trim();
                const p2 = activeUserData?.parentPhoneNumber2?.trim();

                if (!p1 && !p2) {
                    if (!silent) {
                        showToast('נא להזין תחילה לפחות מספר הורה אחד בהגדרות ⚙️', 'warning');
                        setActiveTab('settings');
                    }
                    return;
                }

                const reportData = getWeeklyReportData();
                if (!reportData) {
                    if (!silent) showToast('אין מספיק נתונים להפקת דוח שבועי כרגע', 'info');
                    return;
                }

                const messageText = WhatsAppService.generateParentReportText(activeUserData.name || 'שלי', reportData);
                const recipients = [p1, p2].filter(Boolean);

                recipients.forEach(phone => {
                    WhatsAppService.sendMessage({
                        to: phone,
                        message: messageText,
                        gatewayConfig: activeUserData.whatsappGateway
                    }).catch(err => console.error('Error sending parent report to:', phone, err));
                });

                const currentWeek = getWeekIdentifier();
                updateUserData(prev => ({
                    ...prev,
                    lastWeeklyReportSentWeek: currentWeek
                }));

                if (!silent) {
                    if (activeUserData?.whatsappGateway?.instanceId) {
                        showToast(`דוח שבועי נשלח אוטומטית לוואטסאפ של ${recipients.length > 1 ? 'שני ההורים' : 'ההורים'}! 📨🚀`, 'success');
                    } else {
                        showToast(`נפתח וואטסאפ לשליחת הדוח השבועי להורים 📲`, 'info');
                    }
                }
            };

            // אוטומציה של וואטסאפ: שליחת דוח שבועי במוצאי שבת ותזכורות משימות מתוזמנות
            useEffect(() => {
                if (!activeUserData || !activeUserData.whatsappGateway?.instanceId) return;

                const runWhatsAppAutomationCheck = () => {
                    const now = new Date();
                    const day = now.getDay(); // 6 = Saturday, 0 = Sunday
                    const hour = now.getHours();
                    const currentWeek = getWeekIdentifier(now);

                    // 1. שליחת דוח הורים במוצאי שבת (החל מ-19:00) או בראשון בבוקר
                    const isSaturdayEveningOrSunday = (day === 6 && hour >= 19) || (day === 0 && hour < 14);
                    const alreadySentThisWeek = activeUserData.lastWeeklyReportSentWeek === currentWeek;
                    const autoSendEnabled = activeUserData.autoSendParentReport !== false;

                    if (isSaturdayEveningOrSunday && !alreadySentThisWeek && autoSendEnabled) {
                        const hasParent = activeUserData.parentPhoneNumber || activeUserData.parentPhoneNumber2;
                        if (hasParent) {
                            console.log('Sending automatic Saturday evening parent report via WhatsApp...');
                            handleSendParentWeeklyReportWhatsApp(true);
                        }
                    }

                    // 2. תזכורות משימות חכמות (רק עבור משימות שהופעלו עליהן תזכורות וואטסאפ)
                    if (activeUserData.phoneNumber) {
                        // חישוב חלון זמנים מותר: אם יש בית ספר היום - רק מחצי שעה לפני סיום הלימודים ועד 22:00
                        const todayPlan = (activeUserData.scheduleSettings || []).find(s => s.day === day);
                        const schoolEndTime = todayPlan?.schoolEndTime;
                        const currentMinutes = hour * 60 + now.getMinutes();

                        let canSendRemindersNow = false;
                        if (schoolEndTime) {
                            const [endH, endM] = schoolEndTime.split(':').map(Number);
                            const schoolEndMinutes = endH * 60 + (endM || 0);
                            const reminderStartMinutes = Math.max(0, schoolEndMinutes - 30); // חצי שעה לפני סיום הלימודים
                            canSendRemindersNow = (currentMinutes >= reminderStartMinutes && currentMinutes <= 22 * 60);
                        } else {
                            // יום חופשי / ללא בית ספר: מ-10:00 בבוקר עד 22:00
                            canSendRemindersNow = (hour >= 10 && hour <= 22);
                        }

                        if (canSendRemindersNow) {
                            const activeTasks = (activeUserData.tasks || []).filter(t => !t.completed && t.whatsappRemindersEnabled && t.dueDate);
                            const lastSentMap = activeUserData.lastTaskRemindersSent || {};
                            let updatedSentMap = null;

                            activeTasks.forEach(task => {
                                const lastSentTime = lastSentMap[task.id] || 0;
                                const hoursSince = (Date.now() - lastSentTime) / (1000 * 60 * 60);

                                // שליחה מרווחת (פעם ב-4 שעות לכל היותר למשימה)
                                if (hoursSince >= 4) {
                                    const sub = (activeUserData.subjects || []).find(s => s.id === task.subjectId);
                                    const reminderMsg = WhatsAppService.generateStudentReminderText({
                                        studentName: activeUserData.name || 'שלי',
                                        subjectName: sub ? sub.name : 'כללי',
                                        taskTitle: task.title,
                                        dueDate: task.dueDate,
                                        dueTime: task.dueTime,
                                        freeSlotText: 'הזמן הפנוי שלך לפי הלו"ז'
                                    });

                                    WhatsAppService.sendMessage({
                                        to: activeUserData.phoneNumber,
                                        message: reminderMsg,
                                        gatewayConfig: activeUserData.whatsappGateway
                                    }).then(res => {
                                        if (res && res.status === 'sent_gateway') {
                                            if (!updatedSentMap) updatedSentMap = { ...lastSentMap };
                                            updatedSentMap[task.id] = Date.now();
                                            updateUserData(prev => ({
                                                ...prev,
                                                lastTaskRemindersSent: updatedSentMap
                                            }));
                                        }
                                    }).catch(e => console.error('Automated WhatsApp reminder error:', e));
                                }
                            });
                        }
                    }
                };

                runWhatsAppAutomationCheck();
                const intervalId = setInterval(runWhatsAppAutomationCheck, 10 * 60 * 1000);
                return () => clearInterval(intervalId);
            }, [activeUserData?.whatsappGateway?.instanceId, activeUserData?.lastWeeklyReportSentWeek, activeUserData?.tasks, activeUserData?.scheduleSettings]);

            const [liveFriends, setLiveFriends] = useState({});
            
            // תוקן החיבור למסד הנתונים של חברים - פועל ברקע ומכניס את ה-username פנימה!
            useEffect(() => {
                if (activeUserData?.friends?.length > 0 && typeof db !== 'undefined') {
                    const unsubscribes = [];
                    // מניעת כפילויות בהאזנה על ידי שימוש בסט של שמות משתמש
                    const friendUsernames = [...new Set(activeUserData.friends.map(f => f.username))];
                    
                    friendUsernames.forEach(username => {
                        try {
                            const unsub = db.collection("users").doc(username).onSnapshot(doc => {
                                if (doc.exists) {
                                    // מכניסים את השם המשתמש במפורש פנימה אל תוך הדאטה!
                                    setLiveFriends(prev => ({
                                        ...prev, 
                                        [username]: { ...doc.data(), username: username }
                                    }));
                                }
                            });
                            unsubscribes.push(unsub);
                        } catch (e) { console.error(e); }
                    });
                    
                    return () => { unsubscribes.forEach(u => u && u()); };
                }
            }, [activeUserData?.friends]);


            useEffect(() => {
                if (activeUserData && activeUserData.notifications) {
                    const unread = activeUserData.notifications.filter(n => !n.read);
                    if (unread.length > 0) {
                        unread.forEach(n => {
                            showToast(`הודעה מ-${n.from}: ${n.text}`, 'info');
                        });
                        
                        updateUserData(prev => ({
                            ...prev,
                            notifications: prev.notifications.map(n => ({...n, read: true}))
                        }));
                    }
                }
            }, [activeUserData?.notifications]);


            const [activeTab, setActiveTab] = useState('dashboard');
            const [toastMessage, setToastMessage] = useState(null);
            const [printMode, setPrintMode] = useState(false);
            const [printType, setPrintType] = useState(null);
            const [examPlanData, setExamPlanData] = useState(null);
            const [weeklyReportData, setWeeklyReportData] = useState(null);
            const [analyticsTimeFilter, setAnalyticsTimeFilter] = useState('all');


            const isIOSDevice = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
            const [notificationHelpTab, setNotificationHelpTab] = useState(isIOSDevice ? 'ios' : 'android');

            const [modals, setModals] = useState({
                task: false, complete: false, subject: false, 
                friend: false, pointsHistory: false, streakHistory: false,
                addFriend: false, addAnchor: false, examPlanner: false, cancelExam: false, giveUp: false,
                examGrade: false, quickExam: false, edit: false, reminderMode: false, notificationHelp: false
            });


            const [activeTask, setActiveTask] = useState(null);
            const [taskActionsMenu, setTaskActionsMenu] = useState(null);
            const [selectedTaskForReminder, setSelectedTaskForReminder] = useState(null);
            const [selectedReminderWindow, setSelectedReminderWindow] = useState(null);
            const [reminderTemplateId, setReminderTemplateId] = useState('friendly');
            const [customReminderPhone, setCustomReminderPhone] = useState('');
            const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
            const [editingTask, setEditingTask] = useState(null);
            const [taskToCancel, setTaskToCancel] = useState(null);
            const [taskToGiveUp, setTaskToGiveUp] = useState(null);
            const [activeExamForGrade, setActiveExamForGrade] = useState(null);
            const [activeFriend, setActiveFriend] = useState(null);
            const [editingSubject, setEditingSubject] = useState(null);
            const [tempRules, setTempRules] = useState([]);
            
            const [selectedSettingsDay, setSelectedSettingsDay] = useState(0);
            const [activeDayIndex, setActiveDayIndex] = useState(0);


            const [archiveFilter, setArchiveFilter] = useState('all');
            const [lessonLogFilter, setLessonLogFilter] = useState('all');
            const [taskFilter, setTaskFilter] = useState('all'); 


            const [taskFormHasHW, setTaskFormHasHW] = useState(true);
            const [taskGivenDate, setTaskGivenDate] = useState(() => new Date().toISOString().split('T')[0]);
            const [lateReason, setLateReason] = useState('');
            const [otherLateReason, setOtherLateReason] = useState('');
            const [taskFormSubject, setTaskFormSubject] = useState('');
            const [nowTime, setNowTime] = useState(() => Date.now());

            useEffect(() => {
                const interval = setInterval(() => {
                    setNowTime(Date.now());
                }, 30000);
                return () => clearInterval(interval);
            }, []);

            const pastTopics = useMemo(() => {
                if (!activeUserData || !activeUserData.tasks) return [];
                const topics = activeUserData.tasks
                    .filter(t => (taskFormSubject ? t.subjectId === taskFormSubject : true) && t.lessonTopic && t.lessonTopic.trim() !== '')
                    .map(t => t.lessonTopic.trim());
                return [...new Set(topics)];
            }, [activeUserData?.tasks, taskFormSubject]);
            
            const [examPlannerData, setExamPlannerData] = useState({ 
                step: 1, subjectId: '', examName: '', date: '', hours: 5, targetSessions: 3, sessions: [], remainingMinutes: 0, existingExamId: '' 
            });


            const pieChartRef = useRef(null);
            const chartInstance = useRef(null);
            
            useEffect(() => {
                if (activeTab === 'profile' && pieChartRef.current && activeUserData) {
                    const ctx = pieChartRef.current.getContext('2d');
                    
                    const subjectCounts = {};
                    activeUserData.tasks.forEach(t => {
                        if (t.completed && !t.givenUp) {
                            subjectCounts[t.subjectId] = (subjectCounts[t.subjectId] || 0) + 1;
                        }
                    });
                    
                    const labels = [];
                    const data = [];
                    const backgroundColor = [];
                    
                    Object.keys(subjectCounts).forEach(subId => {
                        const sub = activeUserData.subjects.find(s => s.id === subId);
                        labels.push(sub ? `${sub.emoji} ${sub.name}` : 'כללי');
                        data.push(subjectCounts[subId]);
                        backgroundColor.push(sub ? sub.color : '#a8a29e');
                    });
                    
                    if (chartInstance.current) chartInstance.current.destroy();
                    
                    if (data.length > 0) {
                        chartInstance.current = new Chart(ctx, {
                            type: 'pie',
                            data: {
                                labels: labels,
                                datasets: [{
                                    data: data,
                                    backgroundColor: backgroundColor,
                                    borderWidth: 2,
                                    borderColor: '#ffffff'
                                }]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                plugins: {
                                    legend: { position: 'right', rtl: true, labels: { font: { family: 'Heebo' } } }
                                }
                            }
                        });
                    }
                }
                
                return () => {
                    if (chartInstance.current) chartInstance.current.destroy();
                };
            }, [activeTab, activeUserData?.tasks, activeUserData?.subjects]);


            const showToast = (text, type = 'info') => {
                setToastMessage({ text, type });
                setTimeout(() => setToastMessage(null), 4000);
            };


            const toggleModal = (modalName, val) => setModals(m => ({ ...m, [modalName]: val }));


            const handleLogin = (e) => {
                e.preventDefault();
                const user = e.target.username.value.trim();
                const pass = e.target.password.value;
                if(!user) return;


                if (db) {
                    const userRef = db.collection("users").doc(user);
                    userRef.get().then((doc) => {
                        if (doc.exists) {
                            const data = doc.data();
                            if (data.password !== pass) {
                                showToast('סיסמה שגויה למשתמש הקיים!', 'error');
                                return;
                            }
                            setGlobalState(prev => {
                                const merged = healCompletedFromHistory(applyRemoteUser(prev.users[user], data, null) || data);
                                return {...prev, users: {...prev.users, [user]: merged}, activeUser: user};
                            });
                            showToast(`איזה כיף שחזרת, ${data.name}! ✨`, 'success');
                        } else {
                             const newUser = { ...DEFAULT_USER_STATE, password: pass, name: user };
                             userRef.set(newUser).then(() => {
                                 setGlobalState(prev => ({...prev, users: {...prev.users, [user]: newUser}, activeUser: user}));
                                 showToast('חשבון חדש נוצר בהצלחה וסונכרן לענן! ✨', 'success');
                             });
                        }
                    }).catch(error => {
                        console.log("Fallback to local due to error:", error);
                        setGlobalState(prev => {
                            const users = { ...prev.users };
                            if (users[user]) {
                                if (users[user].password !== pass) {
                                    showToast('סיסמה שגויה למשתמש הקיים!', 'error');
                                    return prev;
                                }
                                showToast(`איזה כיף שחזרת, ${users[user].name}! ✨ (מצב אופליין)`, 'success');
                            } else {
                                users[user] = { ...DEFAULT_USER_STATE, password: pass, name: user };
                                showToast('חשבון חדש נוצר מקומית (מצב אופליין)', 'success');
                            }
                            return { ...prev, users, activeUser: user };
                        });
                    });
                }
            };


            const handleLogout = () => {
                setGlobalState(prev => ({ ...prev, activeUser: null }));
                setActiveTab('dashboard');
            };


            const handleAddTask = (taskData, hasHW) => {
                const now = new Date();
                const actualGivenDate = taskData.givenDate || now.toISOString().split('T')[0];
                
                if (!hasHW) {
                    const noHwTask = {
                        id: 't_' + Date.now(),
                        subjectId: taskData.subjectId,
                        title: 'סיכום שיעור: ' + (taskData.lessonTopic || 'ללא נושא'),
                        lessonTopic: taskData.lessonTopic || '',
                        createdAt: now.toISOString(),
                        completed: true,
                        completedAt: now.toISOString(),
                        isLessonLog: true,
                        understandingRating: null,
                        pointsEarned: 0,
                        givenDate: actualGivenDate
                    };
                    
                    updateUserData(prev => checkAndAwardBadges({ 
                        ...prev, 
                        tasks: [noHwTask, ...prev.tasks]
                    }));
                    toggleModal('task', false);
                    showToast('השיעור תועד בהצלחה ביומן! ✨', 'success');
                } else {
                    const newTask = {
                        ...taskData,
                        id: 't_' + Date.now(),
                        createdAt: now.toISOString(),
                        completed: false,
                        givenDate: actualGivenDate,
                        autoPenaltyApplied: false
                    };
                    updateUserData(prev => ({ ...prev, tasks: [newTask, ...prev.tasks] }));
                    toggleModal('task', false);
                    showToast('המשימה נוספה בהצלחה!', 'success');
                }
            };


            const handleCompleteTask = (task, rating, hardExercises, chosenLateReason) => {
                const now = new Date();
                const createdAt = new Date(task.createdAt);
                let dueDate;
                
                if (task.dueDate && task.dueTime) {
                    dueDate = new Date(`${task.dueDate}T${task.dueTime}`);
                } else {
                    dueDate = new Date(); 
                    dueDate.setHours(23,59,59);
                }


                const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                const totalDurationMs = dueDate.getTime() - createdAt.getTime();
                const usedDurationMs = now.getTime() - createdAt.getTime();
                const isLate = now.getTime() > dueDate.getTime();
                const isSameDay = now.toDateString() === dueDate.toDateString();
                
                let pointsDelta = 0;
                let pointsText = '';
                let streakBroken = false;


                if (!isLate) {
                    if (usedDurationMs <= Math.max(totalDurationMs / 2, 86400000)) { 
                        pointsDelta = 2; pointsText = 'הוגש מוקדם! אלופה.';
                    } else {
                        pointsDelta = 1; pointsText = 'הוגש בזמן שנקבע.';
                    }
                    if (task.isExamPrep) {
                        pointsDelta += 1; pointsText = 'בוצע סשן למידה למבחן (+נקודת בונוס על השקעה)!';
                    }
                } else {
                    streakBroken = true;
                    if (task.autoPenaltyApplied) {
                        pointsDelta = 0;
                        pointsText = `הוגש באיחור (הקנס ירד כבר אוטומטית). סיבה: ${chosenLateReason}`;
                    } else {
                        if (isSameDay) {
                            pointsDelta = -1; pointsText = `הוגש באיחור קל (באותו יום). סיבה: ${chosenLateReason}`;
                        } else {
                            pointsDelta = -2; pointsText = `הוגש באיחור של יום ומעלה. סיבה: ${chosenLateReason}`;
                        }
                    }
                }


                const historyLog = {
                    id: 'ph_' + Date.now(),
                    taskId: task.id,
                    taskTitle: task.title,
                    subjectName: sub ? sub.name : 'כללי',
                    subjectEmoji: sub ? sub.emoji : '📚',
                    points: pointsDelta,
                    date: now.toISOString(),
                    details: pointsText
                };


                let newStreak = activeUserData.taskStreak;
                let newLongest = activeUserData.longestStreak || 0;
                let newStreakStart = activeUserData.currentStreakStart;
                let newStreakEmojis = [...(activeUserData.currentStreakEmojis || [])];
                let newStreakHistory = [...(activeUserData.streakHistory || [])];
                let streakMessage = '';


                if (!streakBroken) {
                    newStreak += 1;
                    if (newStreak === 1) {
                        newStreakStart = now.toISOString();
                        newStreakEmojis = [];
                    }
                    if (sub && sub.name && !newStreakEmojis.includes(sub.name)) newStreakEmojis.push(sub.name); 
                    if (newStreak > newLongest) newLongest = newStreak;
                    streakMessage = `המד עלה ל-${newStreak} 🔥`;
                } else {
                    if (newStreak > 0) {
                        newStreakHistory.push({
                            id: 'sh_' + Date.now(),
                            startDate: newStreakStart,
                            endDate: dueDate.toISOString(),
                            length: newStreak,
                            emojis: newStreakEmojis
                        });
                    }
                    newStreak = 0;
                    newStreakStart = null;
                    newStreakEmojis = [];
                    streakMessage = `הרצף נשבר בגלל האיחור 😢`;
                }


                // Automatically cancel and stop future reminders for this completed task
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({
                        type: 'CANCEL_TASK_REMINDERS',
                        taskId: task.id
                    });
                }

                updateUserData(prev => checkAndAwardBadges({
                    ...prev,
                    tasks: prev.tasks.map(t => t.id === task.id ? { 
                        ...t, completed: true, completedAt: now.toISOString(), 
                        understandingRating: rating, hardExercises: hardExercises, pointsEarned: pointsDelta, lateReason: chosenLateReason,
                        remindersEnabled: false,
                        whatsappRemindersEnabled: false
                    } : t),
                    totalPoints: prev.totalPoints + pointsDelta,
                    weeklyPoints: prev.weeklyPoints + pointsDelta,
                    taskStreak: newStreak,
                    longestStreak: newLongest,
                    currentStreakStart: newStreakStart,
                    currentStreakEmojis: newStreakEmojis,
                    pointsHistory: pointsDelta !== 0 ? [historyLog, ...(prev.pointsHistory || [])] : (prev.pointsHistory || []),
                    streakHistory: newStreakHistory
                }));


                toggleModal('complete', false);
                setActiveTask(null);
                
                if (pointsDelta > 0) {
                    showToast(`כל הכבוד! ${pointsDelta}+ נקודות. ${streakMessage}`, 'success');
                } else {
                    showToast(`המשימה הושלמה ${pointsDelta === 0 ? '(ללא קנס נוסף)' : 'וירדו נקודות'}. ${streakMessage}`, 'warning');
                }
            };


            const handleGiveUpConfirm = () => {
                if (!taskToGiveUp) return;
                const now = new Date();
                const sub = activeUserData.subjects.find(s => s.id === taskToGiveUp.subjectId);
                
                updateUserData(prev => {
                    let newStreak = prev.taskStreak;
                    let newStreakHistory = [...(prev.streakHistory || [])];
                    
                    if (newStreak > 0) {
                        newStreakHistory.push({
                            id: 'sh_' + Date.now(),
                            startDate: prev.currentStreakStart,
                            endDate: now.toISOString(),
                            length: newStreak,
                            emojis: [...(prev.currentStreakEmojis || [])]
                        });
                    }


                    const historyLog = {
                        id: 'ph_' + Date.now(),
                        taskId: taskToGiveUp.id,
                        taskTitle: taskToGiveUp.title,
                        subjectName: sub ? sub.name : 'כללי',
                        subjectEmoji: sub ? sub.emoji : '📚',
                        points: -10,
                        date: now.toISOString(),
                        details: 'ויתור סופי על המשימה 🏳️'
                    };


                    return {
                        ...prev,
                        tasks: prev.tasks.map(t => t.id === taskToGiveUp.id ? { ...t, completed: true, givenUp: true, completedAt: now.toISOString(), pointsEarned: -10 } : t),
                        totalPoints: prev.totalPoints - 10,
                        weeklyPoints: prev.weeklyPoints - 10,
                        taskStreak: 0,
                        currentStreakStart: null,
                        currentStreakEmojis: [],
                        streakHistory: newStreakHistory,
                        pointsHistory: [historyLog, ...(prev.pointsHistory || [])]
                    };
                });
                
                toggleModal('giveUp', false);
                setTaskToGiveUp(null);
                showToast('ויתרת על המשימה. הרצף נשבר וירדו 10 נקודות 😢', 'error');
            };


            const handleDeleteTask = (taskId) => {
                updateUserData(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }));
                showToast('משימה נמחקה', 'success');
            };


            const handleEditTask = (e) => {
                e.preventDefault();
                if (!editingTask) return;
                const oldDue = (editingTask.dueDate && editingTask.dueTime)
                    ? new Date(`${editingTask.dueDate}T${editingTask.dueTime}`)
                    : null;
                const newDueDate = e.target.date.value;
                const newDueTime = e.target.time.value;
                const newDue = (newDueDate && newDueTime) ? new Date(`${newDueDate}T${newDueTime}`) : null;
                updateUserData(prev => {
                    let next = {
                        ...prev,
                        tasks: prev.tasks.map(t => t.id === editingTask.id ? {
                            ...t,
                            subjectId: e.target.subId.value,
                            title: e.target.title.value,
                            lessonTopic: e.target.topic.value,
                            givenDate: e.target.givenDate.value,
                            dueDate: newDueDate || t.dueDate,
                            dueTime: newDueTime || t.dueTime,
                            startTime: e.target.startTime && e.target.startTime.value ? e.target.startTime.value : t.startTime
                        } : t)
                    };
                    if (newDue) {
                        next = restoreOnDueEdit(next, editingTask.id, oldDue, newDue, new Date());
                    }
                    return next;
                });
                toggleModal('edit', false);
                setEditingTask(null);
                showToast('המשימה עודכנה', 'success');
            };


            const handleCancelExamSessionConfirm = () => {
                if (!taskToCancel) return;
                const now = new Date();
                const sub = activeUserData.subjects.find(s => s.id === taskToCancel.subjectId);
                
                updateUserData(prev => {
                    let newStreak = prev.taskStreak;
                    let newStreakStart = prev.currentStreakStart;
                    let newStreakEmojis = [...(prev.currentStreakEmojis || [])];
                    let newStreakHistory = [...(prev.streakHistory || [])];
                    let streakMessage = '';
                    
                    const examIndex = prev.exams ? prev.exams.findIndex(e => e.id === taskToCancel.examId) : -1;
                    const examsCopy = [...(prev.exams || [])];
                    
                    if (examIndex !== -1) {
                        const exam = examsCopy[examIndex];
                        exam.cancellations = (exam.cancellations || 0) + 1;
                        
                        if (exam.cancellations >= 3) {
                            if (newStreak > 0) {
                                newStreakHistory.push({
                                    id: 'sh_' + Date.now(),
                                    startDate: newStreakStart,
                                    endDate: now.toISOString(),
                                    length: newStreak,
                                    emojis: newStreakEmojis
                                });
                            }
                            newStreak = 0;
                            newStreakStart = null;
                            newStreakEmojis = [];
                            streakMessage = ' בוטלו 3 מפגשים למבחן זה, הרצף נשבר! 😢';
                        } else {
                            streakMessage = ` אזהרה: ${exam.cancellations}/3 ביטולים. ביטול נוסף ישבור את הרצף!`;
                        }
                        examsCopy[examIndex] = exam;
                    }


                    const historyLog = {
                        id: 'ph_' + Date.now(),
                        taskId: taskToCancel.id,
                        taskTitle: taskToCancel.title,
                        subjectName: sub ? sub.name : 'כללי',
                        subjectEmoji: sub ? sub.emoji : '📚',
                        points: -4,
                        date: now.toISOString(),
                        details: 'קנס על ביטול מפגש למידה למבחן'
                    };


                    showToast(`המפגש בוטל. ירדו 4 נקודות.${streakMessage}`, 'warning');


                    return {
                        ...prev,
                        tasks: prev.tasks.filter(t => t.id !== taskToCancel.id),
                        totalPoints: prev.totalPoints - 4,
                        weeklyPoints: prev.weeklyPoints - 4,
                        taskStreak: newStreak,
                        currentStreakStart: newStreakStart,
                        currentStreakEmojis: newStreakEmojis,
                        streakHistory: newStreakHistory,
                        pointsHistory: [historyLog, ...(prev.pointsHistory || [])],
                        exams: examsCopy
                    };
                });
                
                toggleModal('cancelExam', false);
                setTaskToCancel(null);
            };


            const handleSaveExamGrade = (e) => {
                e.preventDefault();
                const grade = Number(e.target.grade.value);
                if (!activeExamForGrade) return;


                let pointsDelta = 0;
                let message = '';
                if (grade >= 90) {
                    pointsDelta = 10;
                    message = `מדהים! הציון שלך הוא ${grade}. הרווחת 10 נקודות. תותחית! 🎉`;
                } else if (grade <= 56) {
                    pointsDelta = -5;
                    message = `לא נורא, במבחן הזה קיבלת ${grade}. ירדו 5 נקודות, אבל זה רק אומר שיש מקום לשיפור. נלמד מזה לפעם הבאה! 💪`;
                } else {
                    pointsDelta = 0;
                    message = `הציון הוזן (${grade}). כל הכבוד על המאמץ!`;
                }


                updateUserData(prev => {
                    const updatedExams = prev.exams.map(ex => 
                        ex.id === activeExamForGrade.id ? { ...ex, grade } : ex
                    );
                    
                    const sub = prev.subjects.find(s => s.id === activeExamForGrade.subjectId);
                    
                    const newHistory = pointsDelta !== 0 ? [{
                        id: 'ph_grade_' + Date.now(),
                        taskId: activeExamForGrade.id,
                        taskTitle: `ציון מבחן: ${activeExamForGrade.examName}`,
                        subjectName: sub ? sub.name : 'כללי',
                        subjectEmoji: sub ? sub.emoji : '📚',
                        points: pointsDelta,
                        date: new Date().toISOString(),
                        details: message
                    }, ...(prev.pointsHistory || [])] : (prev.pointsHistory || []);


                    return checkAndAwardBadges({
                        ...prev,
                        exams: updatedExams,
                        totalPoints: prev.totalPoints + pointsDelta,
                        weeklyPoints: prev.weeklyPoints + pointsDelta,
                        pointsHistory: newHistory
                    });
                });


                toggleModal('examGrade', false);
                setActiveExamForGrade(null);
                showToast(message, pointsDelta >= 0 ? 'success' : 'warning');
            };


            const handleRemoveFromLessonLog = (taskId) => {
                updateUserData(prev => ({
                    ...prev,
                    tasks: prev.tasks.map(t => t.id === taskId ? { ...t, lessonTopic: '' } : t)
                }));
                showToast('נושא השיעור הוסר מהיומן', 'success');
            };


            const handleSaveSubject = (subData) => {
                const subToSave = { ...subData, rules: tempRules };
                updateUserData(prev => {
                    const exists = prev.subjects.find(s => s.id === subToSave.id);
                    if (exists) {
                        return { ...prev, subjects: prev.subjects.map(s => s.id === subToSave.id ? subToSave : s) };
                    } else {
                        return { ...prev, subjects: [...prev.subjects, { ...subToSave, id: 's_' + Date.now() }] };
                    }
                });
                toggleModal('subject', false);
                setEditingSubject(null);
                showToast('המקצוע נשמר בהצלחה', 'success');
            };


            const handleDeleteSubject = (id) => {
                updateUserData(prev => ({ ...prev, subjects: prev.subjects.filter(s => s.id !== id) }));
                showToast('מקצוע נמחק', 'success');
            };


            const handleSchoolTimeChange = (dayIndex, time) => {
                updateUserData(prev => {
                    const newSched = [...prev.scheduleSettings];
                    newSched[dayIndex].schoolEndTime = time;
                    return { ...prev, scheduleSettings: newSched };
                });
            };


            const handleAddAnchor = (e) => {
                e.preventDefault();
                const title = e.target.title.value;
                const start = e.target.start.value;
                const end = e.target.end.value;
                
                updateUserData(prev => {
                    const n = [...prev.scheduleSettings];
                    n[activeDayIndex].anchors.push({ id: 'a_'+Date.now(), title, start, end });
                    return {...prev, scheduleSettings: n};
                });
                toggleModal('addAnchor', false);
                showToast('עוגן קבוע נוסף ללו"ז', 'success');
            };


            const handleDeleteAnchor = (dayIdx, anchorId) => {
                updateUserData(prev => {
                    const n = [...prev.scheduleSettings];
                    n[dayIdx].anchors = n[dayIdx].anchors.filter(x => x.id !== anchorId);
                    return {...prev, scheduleSettings: n};
                });
            };


            const handleAddFriend = (e) => {
                e.preventDefault();
                const username = e.target.username.value.trim();
                if(!username) return;


                if (username === globalState.activeUser) {
                    showToast('אי אפשר להוסיף את עצמך 😅', 'warning');
                    return;
                }
                
                if (activeUserData.friends.some(f => f.username === username)) {
                    showToast('המשתמש/ת כבר ברשימת החברות שלך!', 'warning');
                    return;
                }


                if (typeof db !== 'undefined') {
                    db.collection("users").doc(username).get().then((doc) => {
                        if (doc.exists) {
                            const friendData = doc.data();
                            const newFriend = {
                                id: 'f_' + Date.now(),
                                username: username,
                                name: friendData.name || username
                            };
                            updateUserData(prev => ({ ...prev, friends: [...prev.friends, newFriend] }));
                            toggleModal('addFriend', false);
                            showToast(`איזה כיף! ${friendData.name || username} התווסף/ה לרשימה.`, 'success');
                            
                            // שינוי קריטי: הוספת username פנימה ישר בעת ההוספה.
                            setLiveFriends(prev => ({...prev, [username]: { ...friendData, username: username }}));
                        } else {
                            showToast('לא קיים משתמש עם השם הזה במערכת 😢', 'error');
                        }
                    }).catch(err => {
                        showToast('שגיאה בתקשורת עם השרת', 'error');
                    });
                }
            };


            const handleSendNudge = async (friendUsername) => {
                if (typeof db === 'undefined') return;
                try {
                    const friendRef = db.collection("users").doc(friendUsername);
                    const doc = await friendRef.get();
                    if (doc.exists) {
                        const friendData = doc.data();
                        const newNotification = {
                            id: 'n_' + Date.now(),
                            from: activeUserData.name,
                            text: 'היי, מה עם השיעורים? מתקדמת? 👀',
                            read: false,
                            timestamp: Date.now()
                        };
                        const updatedNotifications = [...(friendData.notifications || []), newNotification];
                        await friendRef.update({ 
                            notifications: updatedNotifications,
                            lastSync: Date.now() 
                        });
                        showToast('ההודעה נשלחה לחברה בהצלחה! 🔔', 'success');
                        toggleModal('friend', false);
                    } else {
                        showToast('המשתמש לא קיים במסד הנתונים', 'error');
                    }
                } catch (error) {
                    showToast('שגיאה בשליחת ההודעה', 'error');
                }
            };


            const handleRemoveFriend = (id) => {
                updateUserData(prev => ({ ...prev, friends: prev.friends.filter(f => f.id !== id) }));
                toggleModal('friend', false);
                showToast('חברה הוסרה', 'success');
            };

            const handleCopyFriendTask = (friendTask) => {
                if (!friendTask) return;
                // Find matching subject by id or name, or fallback to first subject
                const matchingSub = (activeUserData.subjects || []).find(s => s.id === friendTask.subjectId || s.name === friendTask.subjectName) || (activeUserData.subjects && activeUserData.subjects[0]);
                const subId = matchingSub ? matchingSub.id : '';
                
                const newTask = {
                    id: 't_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                    subjectId: subId,
                    title: friendTask.title || 'משימה מחברה',
                    lessonTopic: friendTask.lessonTopic || '',
                    dueDate: friendTask.dueDate || null,
                    dueTime: friendTask.dueTime || null,
                    startTime: friendTask.startTime || null,
                    createdAt: new Date().toISOString(),
                    completed: false,
                    givenDate: friendTask.givenDate || new Date().toISOString().split('T')[0],
                    autoPenaltyApplied: false
                };

                updateUserData(prev => ({
                    ...prev,
                    tasks: [newTask, ...(prev.tasks || [])]
                }));
                showToast(`המשימה "${friendTask.title}" הועתקה לרשימה שלך! 💕`, 'success');
            };


            const handleGenerateExam = (subjectId) => {
                if (!subjectId) {
                    showToast('יש לבחור מקצוע מהרשימה', 'warning');
                    return;
                }
                const subObj = (activeUserData.subjects || []).find(s => s.id === subjectId || s.name === subjectId);
                const subjectIdTarget = subObj ? subObj.id : subjectId;
                const subjectName = subObj ? `${subObj.emoji || ''} ${subObj.name}` : (subjectId || 'כללי');
                const cleanSubName = subObj ? subObj.name.trim().toLowerCase() : (typeof subjectId === 'string' ? subjectId.trim().toLowerCase() : '');

                const isMatchingTask = (t) => {
                    if (!t) return false;
                    if (t.subjectId === subjectIdTarget || t.subjectId === subjectId) return true;
                    if (subObj) {
                        if (t.subjectId === subObj.name) return true;
                        if (t.subjectName && t.subjectName.trim().toLowerCase() === cleanSubName) return true;
                        if (t.subjectId && typeof t.subjectId === 'string' && subObj.id && t.subjectId.toLowerCase() === subObj.id.toLowerCase()) return true;
                    }
                    if (cleanSubName && t.subjectId && typeof t.subjectId === 'string' && t.subjectId.trim().toLowerCase() === cleanSubName) return true;
                    return false;
                };

                // All tasks and lesson logs belonging to this subject (both completed and pending)
                const allSubTasks = (activeUserData.tasks || []).filter(isMatchingTask);

                // 1. All unique lesson topics and titles
                const topicsMap = new Map();
                allSubTasks.forEach(t => {
                    let topic = (t.lessonTopic && t.lessonTopic.trim()) || '';
                    if (!topic && t.isLessonLog && t.title) {
                        topic = t.title.replace(/^סיכום שיעור:\s*/, '').trim();
                    }
                    if (!topic && t.title) {
                        topic = t.title.trim();
                    }
                    if (topic) {
                        const existing = topicsMap.get(topic) || { count: 0, date: '', hasHw: false, understanding: [] };
                        existing.count++;
                        const d = t.givenDate || (t.createdAt ? t.createdAt.split('T')[0] : '') || (t.completedAt ? t.completedAt.split('T')[0] : '');
                        if (!existing.date || (d && d > existing.date)) {
                            existing.date = d;
                        }
                        if (!t.isLessonLog) {
                            existing.hasHw = true;
                        }
                        if (t.understandingRating) {
                            existing.understanding.push(Number(t.understandingRating));
                        }
                        topicsMap.set(topic, existing);
                    }
                });

                const allTopicsList = Array.from(topicsMap.entries()).map(([topic, info]) => {
                    const avgRating = info.understanding.length > 0 
                        ? (info.understanding.reduce((a, b) => a + b, 0) / info.understanding.length).toFixed(1)
                        : null;
                    return {
                        topic,
                        date: info.date,
                        count: info.count,
                        hasHw: info.hasHw,
                        avgRating
                    };
                }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

                // 2. All homework tasks in this subject
                const homeworkTasks = allSubTasks.filter(t => !t.isLessonLog).sort((a, b) => {
                    const dateA = a.dueDate || a.givenDate || a.createdAt || '';
                    const dateB = b.dueDate || b.givenDate || b.createdAt || '';
                    return dateB.localeCompare(dateA);
                });

                // 3. Weaknesses and difficulties (understanding <= 3)
                const weakTasks = homeworkTasks.filter(t => t.completed && t.understandingRating && Number(t.understandingRating) <= 3);

                // 4. Hard exercises recorded
                const hardEx = allSubTasks.filter(t => t.hardExercises && t.hardExercises.trim() !== '').map(t => ({
                    title: t.title,
                    ex: t.hardExercises,
                    date: t.completedAt || t.dueDate || t.createdAt,
                    topic: t.lessonTopic || t.title
                }));

                // 5. Given up tasks
                const givenUpTasks = allSubTasks.filter(t => t.givenUp);

                // 6. Previous exams in this subject
                const subjectExams = (activeUserData.exams || []).filter(e => 
                    e.subjectId === subjectIdTarget || e.subjectId === subjectId || (subObj && (e.subjectName === subObj.name || (e.examName && cleanSubName && e.examName.toLowerCase().includes(cleanSubName))))
                ).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

                const gradedExams = subjectExams.filter(e => e.grade && !isNaN(Number(e.grade)));
                const examAvg = gradedExams.length > 0 
                    ? (gradedExams.reduce((sum, e) => sum + Number(e.grade), 0) / gradedExams.length).toFixed(1)
                    : null;

                // Overall metrics
                const completedHwCount = homeworkTasks.filter(t => t.completed && !t.givenUp).length;
                const ratedTasks = homeworkTasks.filter(t => t.completed && t.understandingRating);
                const avgUnderstanding = ratedTasks.length > 0 
                    ? (ratedTasks.reduce((sum, t) => sum + Number(t.understandingRating), 0) / ratedTasks.length).toFixed(1)
                    : null;

                setExamPlanData({
                    subjectId: subjectIdTarget,
                    subjectName,
                    subObj,
                    allTopicsList,
                    homeworkTasks,
                    weakTasks,
                    hardEx,
                    givenUpTasks,
                    subjectExams,
                    examAvg,
                    avgUnderstanding,
                    completedHwCount,
                    date: new Date().toLocaleDateString('he-IL')
                });

                setPrintType('exam');
                setPrintMode(true);
                setTimeout(() => {
                    window.print();
                    setPrintMode(false);
                    setPrintType(null);
                }, 500);
            };


            const handleGenerateWeeklyReport = () => {
                const report = getWeeklyReportData();
                if (!report) return;
                setWeeklyReportData(report);

                setPrintType('weekly');
                setPrintMode(true);
                setTimeout(() => {
                    window.print();
                    setPrintMode(false);
                    setPrintType(null);
                }, 500);
            };


            const handlePrintAnalyticsReport = () => {
                setPrintType('analytics');
                setPrintMode(true);
                setTimeout(() => {
                    window.print();
                    setPrintMode(false);
                    setPrintType(null);
                }, 500);
            };


            const handleGenerateStudyPlan = (e) => {
                e.preventDefault();
                const subId = examPlannerData.subjectId;
                const targetDate = examPlannerData.date;
                const hours = examPlannerData.hours;
                const targetSessions = examPlannerData.targetSessions;


                if (!subId || !targetDate) { showToast('יש למלא מקצוע ותאריך', 'warning'); return; }


                const totalMinutes = hours * 60;
                const chunkMinutes = Math.ceil(totalMinutes / targetSessions);


                const start = new Date();
                start.setHours(0,0,0,0);
                const end = new Date(targetDate);
                end.setHours(0,0,0,0);


                const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                if (daysDiff <= 0) {
                    showToast('תאריך המבחן חייב להיות מחר או מאוחר יותר', 'error');
                    return;
                }


                const nowTime = new Date();
                const currentMinsNow = nowTime.getHours() * 60 + nowTime.getMinutes();
                const todayStr = nowTime.toDateString();


                let allAvailableWindows = [];


                for (let i = 0; i < daysDiff; i++) {
                    const current = new Date();
                    current.setDate(current.getDate() + i);
                    const dayOfWeek = current.getDay();
                    const isToday = current.toDateString() === todayStr;


                    const dayPlan = activeUserData.scheduleSettings[dayOfWeek];
                    const isFreeDay = !dayPlan.schoolEndTime;
                    const windows = isFreeDay && dayPlan.anchors.length === 0
                        ? [{ start: '08:00', end: '22:00' }]
                        : calculateSmartWindows(dayPlan.schoolEndTime || '08:30', dayPlan.anchors);


                    if (!windows) continue;


                    for (let w of windows) {
                        let wStartMins = timeToMins(w.start);
                        let wEndMins = timeToMins(w.end);


                        if (isToday) {
                            if (wEndMins <= currentMinsNow) continue; 
                            if (wStartMins < currentMinsNow) {
                                wStartMins = currentMinsNow + 15; 
                            }
                        }


                        const windowDuration = wEndMins - wStartMins;
                        if (windowDuration >= 30) {
                            allAvailableWindows.push({
                                date: current.toISOString().split('T')[0],
                                startMins: wStartMins,
                                endMins: wEndMins,
                                duration: windowDuration
                            });
                        }
                    }
                }


                let selectedWindows = [];
                if (allAvailableWindows.length <= targetSessions) {
                    selectedWindows = allAvailableWindows; 
                } else {
                    const step = allAvailableWindows.length / targetSessions;
                    for (let i = 0; i < targetSessions; i++) {
                        const idx = Math.floor(i * step);
                        selectedWindows.push(allAvailableWindows[idx]);
                    }
                }


                const sessions = [];
                let remainingMinutes = totalMinutes;


                for (let w of selectedWindows) {
                    if (remainingMinutes <= 0) break;
                    const sessionDuration = Math.min(w.duration, remainingMinutes, chunkMinutes); 
                    remainingMinutes -= sessionDuration;


                    sessions.push({
                        id: 'ses_' + Date.now() + Math.random(),
                        date: w.date,
                        startTime: minsToTime(w.startMins),
                        endTime: minsToTime(w.startMins + sessionDuration),
                        duration: sessionDuration
                    });
                }


                setExamPlannerData({...examPlannerData, step: 2, sessions, remainingMinutes});
            };


            const handleConfirmStudyPlan = () => {
                const sub = activeUserData.subjects.find(s => s.id === examPlannerData.subjectId);
                const examTitle = examPlannerData.examName || 'מבחן';
                const reuseId = examPlannerData.existingExamId;
                const examId = reuseId || ('ex_' + Date.now());
                
                const newTasks = examPlannerData.sessions.map((ses, idx) => ({
                    id: 't_' + Date.now() + idx,
                    examId: examId,
                    subjectId: examPlannerData.subjectId,
                    title: `למידה ל${examTitle} ב${sub?.name || 'כללי'} (מפגש ${idx+1}/${examPlannerData.sessions.length})`,
                    lessonTopic: `הכנה למבחן: ${examTitle}`,
                    createdAt: new Date().toISOString(),
                    completed: false,
                    isLessonLog: false,
                    isExamPrep: true,
                    givenDate: new Date().toISOString().split('T')[0],
                    dueDate: ses.date,
                    startTime: ses.startTime,
                    dueTime: ses.endTime,
                    autoPenaltyApplied: false
                }));


                updateUserData(prev => {
                    const exams = [...(prev.exams || [])];
                    if (reuseId) {
                        return {
                            ...prev,
                            tasks: [...prev.tasks, ...newTasks],
                            exams: exams.map(ex => ex.id === reuseId ? {
                                ...ex,
                                sessionsCount: (ex.sessionsCount || 0) + newTasks.length,
                                targetHours: (ex.targetHours || 0) + examPlannerData.hours
                            } : ex)
                        };
                    }
                    return {
                        ...prev,
                        tasks: [...prev.tasks, ...newTasks],
                        exams: [...exams, { id: examId, examName: examTitle, subjectId: examPlannerData.subjectId, date: examPlannerData.date, targetHours: examPlannerData.hours, sessionsCount: examPlannerData.sessions.length, cancellations: 0 }]
                    };
                });


                toggleModal('examPlanner', false);
                showToast(`שובצו ${examPlannerData.sessions.length} מפגשי למידה בהצלחה! תוכלי לראות אותם במשימות. 🧠`, 'success');
                setExamPlannerData({ step: 1, subjectId: '', examName: '', date: '', hours: 5, targetSessions: 3, sessions: [], remainingMinutes: 0, existingExamId: '' });
            };


            const handleAddQuickExam = (e) => {
                e.preventDefault();
                const subjectId = e.target.subjectId.value;
                const examName = e.target.examName.value;
                const date = e.target.date.value;
                
                const newExam = {
                    id: 'ex_' + Date.now(),
                    subjectId,
                    examName,
                    date,
                    targetHours: 0,
                    sessionsCount: 0,
                    cancellations: 0
                };
                
                updateUserData(prev => ({
                    ...prev,
                    exams: [...(prev.exams || []), newExam]
                }));
                
                toggleModal('quickExam', false);
                showToast('המבחן נוסף למערכת בהצלחה! 🎉', 'success');
            };

            const handleDeleteExam = (examId) => {
                if (!window.confirm('האם את בטוחה שברצונך למחוק את המבחן? פעולה זו תסיר גם את מפגשי הלמידה שתוכננו עבורו בלוח המשימות.')) {
                    return;
                }
                updateUserData(prev => ({
                    ...prev,
                    exams: (prev.exams || []).filter(e => e.id !== examId),
                    tasks: (prev.tasks || []).filter(t => t.examId !== examId)
                }));
                showToast('המבחן נמחק בהצלחה', 'info');
            };


            const handleAddExamToCalendar = (exam) => {
                const sub = activeUserData.subjects.find(s => s.id === exam.subjectId);
                const subjectName = sub ? sub.name : 'כללי';
                const title = `מבחן: ${exam.examName || 'מבחן'} ב${subjectName}`;
                
                const dueDate = new Date(exam.date);
                dueDate.setHours(8, 0, 0);


                const formatICSDate = (date) => {
                    return date.toISOString().replace(/-|:/g, '').split('.')[0] + 'Z';
                };


                const dtstart = formatICSDate(dueDate);
                const endDate = new Date(dueDate.getTime() + 2 * 60 * 60 * 1000); 
                const dtend = formatICSDate(endDate);


                let alarms = '';
                const daysUntil = Math.max(1, Math.floor((dueDate - new Date()) / (1000 * 60 * 60 * 24)));
                
                [1, 2, 3, 5, 7, 10, 14].forEach(days => {
                    if (days <= daysUntil + 1) {
                        alarms += `\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:תזכורת: ${title} בעוד ${days} ימים!\nTRIGGER:-P${days}D\nEND:VALARM`;
                    }
                });


                const icsContent = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//StudyStreak//HE\nCALSCALE:GREGORIAN\nBEGIN:VEVENT\nUID:${exam.id}@studystreak.app\nDTSTAMP:${formatICSDate(new Date())}\nDTSTART:${dtstart}\nDTEND:${dtend}\nSUMMARY:${title}\nDESCRIPTION:בהצלחה במבחן!${alarms}\nEND:VEVENT\nEND:VCALENDAR`;


                const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
                const link = document.createElement('a');
                link.href = window.URL.createObjectURL(blob);
                link.setAttribute('download', `${title}.ics`);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);


                showToast('המבחן ירד כקובץ יומן! פתחי אותו כדי להוסיף ליומן שלך 📅', 'success');
            };


            if (printMode) {
                if (printType === 'exam' && examPlanData) {
                    const {
                        subjectName,
                        allTopicsList = [],
                        homeworkTasks = [],
                        weakTasks = [],
                        hardEx = [],
                        givenUpTasks = [],
                        subjectExams = [],
                        examAvg,
                        avgUnderstanding,
                        completedHwCount = 0,
                        date
                    } = examPlanData;

                    return (
                        <div id="print-area" className="bg-white text-black p-8 font-sans text-right" dir="rtl">
                            {/* Header */}
                            <div className="text-center mb-6 border-b-2 border-stone-800 pb-4">
                                <div className="flex items-center justify-between text-xs text-stone-500 font-bold mb-2">
                                    <span className="bg-purple-50 text-purple-900 px-2.5 py-1 rounded-lg border border-purple-200">StudyStreak Pro • כיתה י"ב</span>
                                    <span>תאריך הפקה: {date}</span>
                                </div>
                                <h1 className="text-3xl font-black text-stone-900 mb-1">חוברת הכנה מקיפה למבחן: {subjectName}</h1>
                                <p className="text-base font-bold text-stone-600">
                                    תלמידה: {activeUserData.name} • תיק למידה מרוכז לקראת הבחינה
                                </p>
                            </div>

                            {/* Summary KPI Cards */}
                            <div className="grid grid-cols-4 gap-3 mb-6">
                                <div className="bg-stone-50 p-3.5 rounded-xl text-center border border-stone-200">
                                    <div className="text-[11px] text-stone-500 font-bold mb-0.5 uppercase">נושאים שנלמדו</div>
                                    <div className="text-2xl font-black text-stone-800">{allTopicsList.length} 📖</div>
                                </div>
                                <div className="bg-stone-50 p-3.5 rounded-xl text-center border border-stone-200">
                                    <div className="text-[11px] text-stone-500 font-bold mb-0.5 uppercase">שיעורי בית ומשימות</div>
                                    <div className="text-2xl font-black text-purple-700">{completedHwCount} / {homeworkTasks.length} ✅</div>
                                </div>
                                <div className="bg-stone-50 p-3.5 rounded-xl text-center border border-stone-200">
                                    <div className="text-[11px] text-stone-500 font-bold mb-0.5 uppercase">מדד הבנה ממוצע</div>
                                    <div className="text-2xl font-black text-amber-600">{avgUnderstanding ? `${avgUnderstanding} / 5 ⭐️` : '-'}</div>
                                </div>
                                <div className="bg-stone-50 p-3.5 rounded-xl text-center border border-stone-200">
                                    <div className="text-[11px] text-stone-500 font-bold mb-0.5 uppercase">ממוצע מבחנים קודמים</div>
                                    <div className="text-2xl font-black text-indigo-600">{examAvg ? `${examAvg} 🎓` : '-'}</div>
                                </div>
                            </div>

                            {/* Section 1: Lesson Topics */}
                            <div className="mb-6">
                                <h2 className="text-base font-bold bg-purple-50 text-purple-900 p-2.5 mb-3 rounded-lg border border-purple-200 flex items-center justify-between">
                                    <span>📚 סילבוס ונושאי הלימוד שנלמדו השנה ({allTopicsList.length})</span>
                                    <span className="text-xs font-normal text-purple-700">סמני V בתיבה לצד כל נושא שחזרת עליו</span>
                                </h2>
                                {allTopicsList.length > 0 ? (
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        {allTopicsList.map((item, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-2.5 rounded-lg border border-stone-200 bg-stone-50/60">
                                                <div className="flex items-center gap-2">
                                                    <span className="inline-block w-4 h-4 border-2 border-stone-400 rounded bg-white shrink-0"></span>
                                                    <span className="font-bold text-stone-800">{item.topic}</span>
                                                </div>
                                                <div className="flex items-center gap-2 text-[11px] text-stone-500">
                                                    {item.date && <span>{new Date(item.date).toLocaleDateString('he-IL', {day:'2-digit', month:'2-digit'})}</span>}
                                                    {item.avgRating && <span className="text-amber-800 font-bold bg-amber-100/80 px-1.5 py-0.5 rounded">{item.avgRating}★</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-stone-500 text-xs italic p-3 bg-stone-50 rounded-lg border border-stone-200">
                                        לא תועדו נושאי שיעור עדיין.
                                    </div>
                                )}
                            </div>

                            {/* Section 2: Homework List */}
                            <div className="mb-6">
                                <h2 className="text-base font-bold bg-stone-100 text-stone-900 p-2.5 mb-3 rounded-lg border border-stone-200 flex items-center justify-between">
                                    <span>📝 ריכוז שיעורי הבית והמשימות במקצוע ({homeworkTasks.length})</span>
                                    <span className="text-xs font-normal text-stone-500">מעקב מלא אחרי כל המטלות</span>
                                </h2>
                                {homeworkTasks.length > 0 ? (
                                    <table className="w-full text-right border-collapse text-xs">
                                        <thead>
                                            <tr className="border-b-2 border-stone-300 text-stone-600">
                                                <th className="py-1.5 px-2">משימה</th>
                                                <th className="py-1.5 px-2">נושא</th>
                                                <th className="py-1.5 px-2">מועד הגשה</th>
                                                <th className="py-1.5 px-2 text-center">סטטוס</th>
                                                <th className="py-1.5 px-2 text-center">הבנה</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-stone-200">
                                            {homeworkTasks.map((t, i) => (
                                                <tr key={t.id || i} className={t.givenUp ? 'bg-stone-50 text-stone-400' : ''}>
                                                    <td className="py-2 px-2 font-bold text-stone-800">{t.title}</td>
                                                    <td className="py-2 px-2 text-stone-600">{t.lessonTopic || '-'}</td>
                                                    <td className="py-2 px-2 text-stone-500" dir="rtl">
                                                        {t.dueDate ? new Date(t.dueDate).toLocaleDateString('he-IL') : (t.givenDate ? new Date(t.givenDate).toLocaleDateString('he-IL') : '-')}
                                                    </td>
                                                    <td className="py-2 px-2 text-center font-bold">
                                                        {t.completed ? (
                                                            <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">הוגש ✅</span>
                                                        ) : t.givenUp ? (
                                                            <span className="text-stone-500 bg-stone-100 px-2 py-0.5 rounded">ויתרתי 🏳️</span>
                                                        ) : (
                                                            <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">פתוח ⏳</span>
                                                        )}
                                                    </td>
                                                    <td className="py-2 px-2 text-center font-black">
                                                        {t.understandingRating ? (
                                                            <span className={t.understandingRating <= 2 ? 'text-rose-600 font-black' : t.understandingRating === 3 ? 'text-amber-600' : 'text-emerald-600'}>
                                                                {t.understandingRating} / 5
                                                            </span>
                                                        ) : (
                                                            <span className="text-stone-400 font-normal">טרם דורג</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="text-stone-500 text-xs italic p-3 bg-stone-50 rounded-lg border border-stone-200">
                                        לא תועדו משימות שיעורי בית למקצוע זה.
                                    </div>
                                )}
                            </div>

                            {/* Section 3: Weaknesses & Difficulties */}
                            <div className="mb-6">
                                <h2 className="text-base font-bold bg-rose-50 text-rose-900 p-2.5 mb-3 rounded-lg border border-rose-200">
                                    🎯 מוקדי קושי, נושאים לחיזוק ותרגילים מאתגרים
                                </h2>
                                
                                <div className="mb-3">
                                    <div className="text-xs font-bold text-stone-700 mb-1.5">⚡ נושאים שסומנו בהבנה נמוכה (דורשים חזרה ממוקדת):</div>
                                    {weakTasks.length > 0 ? (
                                        <div className="space-y-1.5">
                                            {weakTasks.map(t => (
                                                <div key={t.id} className="p-2 bg-rose-50/70 rounded-lg border border-rose-100 text-xs flex items-center justify-between">
                                                    <span className="font-bold text-rose-800">{t.lessonTopic || t.title}</span>
                                                    <span className="text-rose-600 font-bold bg-white px-2 py-0.5 rounded border border-rose-200">הבנה: {t.understandingRating}/5</span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-emerald-700 text-xs bg-emerald-50 p-2 rounded-lg border border-emerald-100">
                                            ✨ מעולה! לא סומנו משימות בהבנה נמוכה. נראה שאת שולטת בחומר היטב.
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <div className="text-xs font-bold text-stone-700 mb-1.5">🧩 תרגילים וסעיפים קשים שנרשמו במהלך הלמידה:</div>
                                    {hardEx.length > 0 ? (
                                        <div className="space-y-2">
                                            {hardEx.map((item, idx) => (
                                                <div key={idx} className="p-2.5 bg-stone-50 rounded-lg border border-stone-200 text-xs">
                                                    <div className="flex justify-between items-center mb-1">
                                                        <span className="font-bold text-stone-800">{item.title} {item.topic && `(${item.topic})`}</span>
                                                        {item.date && <span className="text-stone-400" dir="ltr">{new Date(item.date).toLocaleDateString('he-IL')}</span>}
                                                    </div>
                                                    <div className="text-rose-700 font-medium bg-white p-2 rounded border border-rose-100">
                                                        {item.ex}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-stone-500 text-xs italic p-2 bg-stone-50 rounded-lg border border-stone-200">
                                            לא נרשמו תרגילים קשים ספציפיים במשימות.
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Section 4: Previous Exams & Grades */}
                            <div className="mb-6">
                                <h2 className="text-base font-bold bg-indigo-50 text-indigo-900 p-2.5 mb-3 rounded-lg border border-indigo-200 flex items-center justify-between">
                                    <span>📊 היסטוריית מבחנים וציונים קודמים ב{subjectName}</span>
                                    {examAvg && <span className="text-xs font-bold text-indigo-700">ממוצע מצטבר: {examAvg}</span>}
                                </h2>
                                {subjectExams.length > 0 ? (
                                    <table className="w-full text-right border-collapse text-xs">
                                        <thead>
                                            <tr className="border-b-2 border-stone-300 text-stone-600">
                                                <th className="py-1.5 px-2">בחינה</th>
                                                <th className="py-1.5 px-2">תאריך</th>
                                                <th className="py-1.5 px-2 text-center">ציון</th>
                                                <th className="py-1.5 px-2 text-center">סטטוס</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-stone-200">
                                            {subjectExams.map(e => (
                                                <tr key={e.id}>
                                                    <td className="py-1.5 px-2 font-bold text-stone-800">{e.examName}</td>
                                                    <td className="py-1.5 px-2 text-stone-600" dir="rtl">{e.date ? new Date(e.date).toLocaleDateString('he-IL') : '-'}</td>
                                                    <td className="py-1.5 px-2 text-center font-black text-indigo-700 text-sm">
                                                        {e.grade ? e.grade : '-'}
                                                    </td>
                                                    <td className="py-1.5 px-2 text-center">
                                                        {e.grade ? <span className="text-emerald-700 font-bold">הושלם</span> : <span className="text-amber-700 font-bold">עתידי</span>}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="text-stone-500 text-xs italic p-3 bg-stone-50 rounded-lg border border-stone-200">
                                        טרם הוזנו מבחנים קודמים למקצוע זה במערכת.
                                    </div>
                                )}
                            </div>

                            {/* Section 5: Exam Day Checklist */}
                            <div className="mb-6 p-3.5 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50/50 text-xs">
                                <div className="font-bold text-stone-800 mb-2">📋 צ'ק-ליסט אישי לקראת המבחן:</div>
                                <div className="grid grid-cols-2 gap-2 text-[11px]">
                                    <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> חזרה על כל הגדרות ונוסחאות החומר</div>
                                    <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> פתרון חוזר של התרגילים המאתגרים</div>
                                    <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> תרגול לפחות מבחן מתכונת אחד לדוגמה</div>
                                    <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> שינה טובה וארוחת בוקר ביום הבחינה</div>
                                </div>
                            </div>

                            {/* Footer */}
                            <div className="text-center mt-6 text-xs text-stone-400 font-bold border-t border-stone-200 pt-3">
                                StudyStreak Pro • המון הצלחה בבחינה! 🍀
                            </div>
                        </div>
                    );
                } else if (printType === 'weekly' && weeklyReportData) {
                    return (
                        <div id="print-area" className="bg-white text-black p-8 font-sans text-right" dir="rtl">
                            <div className="text-center mb-8 border-b-2 border-stone-800 pb-4">
                                <h1 className="text-3xl font-bold mb-2">דוח התקדמות שבועי - StudyStreak Pro</h1>
                                <p className="text-lg font-bold text-stone-600 mb-1">תלמידה: {activeUserData.name}</p>
                                <p className="text-sm text-stone-500 font-medium">שבוע: {weeklyReportData.startDate} עד {weeklyReportData.endDate}</p>
                            </div>
                            
                            <div className="flex gap-4 mb-8">
                                <div className="flex-1 bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
                                    <div className="text-sm text-stone-500 font-bold mb-1 uppercase">משימות הושלמו</div>
                                    <div className="text-3xl font-black text-emerald-600">{weeklyReportData.completedHW.length}</div>
                                </div>
                                <div className="flex-1 bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
                                    <div className="text-sm text-stone-500 font-bold mb-1 uppercase">סשנים למבחנים</div>
                                    <div className="text-3xl font-black text-indigo-600">{weeklyReportData.examPrepDone.length}</div>
                                </div>
                                <div className="flex-1 bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
                                    <div className="text-sm text-stone-500 font-bold mb-1 uppercase">נקודות השבוע</div>
                                    <div className="text-3xl font-black text-purple-600">{weeklyReportData.totalPointsGained}</div>
                                </div>
                            </div>


                            <div className="mb-8">
                                <h2 className="text-xl font-bold bg-stone-100 p-3 mb-4 rounded-xl border border-stone-200 flex items-center gap-2"><span>📚</span> שיעורי בית ומשימות שהוגשו השבוע</h2>
                                {weeklyReportData.completedHW.length > 0 ? (
                                    <ul className="list-disc list-inside space-y-2 text-base">
                                        {weeklyReportData.completedHW.map(t => {
                                            const sub = activeUserData.subjects.find(s=>s.id === t.subjectId);
                                            return <li key={t.id}><strong>{sub ? sub.name : 'כללי'}:</strong> {t.title} <span className="text-stone-500 text-sm font-medium mr-1">(דירוג הבנה: {t.understandingRating}/5)</span></li>
                                        })}
                                    </ul>
                                ) : <p className="text-base text-stone-500 italic">לא הושלמו משימות השבוע.</p>}
                            </div>


                            <div className="mb-8">
                                <h2 className="text-xl font-bold bg-stone-100 p-3 mb-4 rounded-xl border border-stone-200 flex items-center gap-2"><span>🧠</span> הכנה למבחנים ולמידה עצמית</h2>
                                {weeklyReportData.examPrepDone.length > 0 ? (
                                    <ul className="list-disc list-inside space-y-2 text-base">
                                        {weeklyReportData.examPrepDone.map(t => (
                                            <li key={t.id}>{t.title}</li>
                                        ))}
                                    </ul>
                                ) : <p className="text-base text-stone-500 italic">לא התקיימו מפגשי הכנה למבחנים השבוע.</p>}
                            </div>


                            {weeklyReportData.thisWeekExams.length > 0 && (
                                <div className="mb-8">
                                    <h2 className="text-xl font-bold bg-stone-100 p-3 mb-4 rounded-xl border border-stone-200 flex items-center gap-2"><span>📝</span> מבחנים שהתקיימו השבוע</h2>
                                    <ul className="list-disc list-inside space-y-2 text-base">
                                        {weeklyReportData.thisWeekExams.map(e => {
                                            const sub = activeUserData.subjects.find(s=>s.id === e.subjectId);
                                            return <li key={e.id}><strong>{e.examName} ({sub ? sub.name : 'כללי'})</strong> - {e.grade ? `הוזן ציון: ${e.grade}` : 'טרם הוזן ציון'}</li>
                                        })}
                                    </ul>
                                </div>
                            )}


                            {weeklyReportData.givenUpHW.length > 0 && (
                                <div className="mb-8">
                                    <h2 className="text-xl font-bold bg-rose-50 p-3 mb-4 rounded-xl border border-rose-200 text-rose-800 flex items-center gap-2"><span>⚠️</span> משימות שבוטלו / ויתור</h2>
                                    <ul className="list-disc list-inside space-y-2 text-base text-rose-700">
                                        {weeklyReportData.givenUpHW.map(t => {
                                            const sub = activeUserData.subjects.find(s=>s.id === t.subjectId);
                                            return <li key={t.id}><strong>{sub ? sub.name : 'כללי'}:</strong> {t.title}</li>
                                        })}
                                    </ul>
                                </div>
                            )}


                            <div className="text-center mt-12 text-sm text-stone-400 font-bold border-t-2 border-stone-100 pt-6">
                                הופק אוטומטית מ-StudyStreak Pro במטרה לעקוב ולשפר את הלמידה. כל הכבוד על המאמץ!
                            </div>
                        </div>
                    );
                } else if (printType === 'analytics') {
                    const allTasks = activeUserData.tasks || [];
                    const rawCompletedTasks = allTasks.filter(t => t.completed && !t.givenUp && !t.isLessonLog);
                    const rawExams = activeUserData.exams || [];

                    const formatMonthLabel = (ymStr) => {
                        try {
                            const [year, month] = ymStr.split('-').map(Number);
                            const d = new Date(year, month - 1, 1);
                            return d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
                        } catch(e) {
                            return ymStr;
                        }
                    };

                    const getTaskDate = (t) => t.completedAt ? new Date(t.completedAt) : (t.dueDate ? new Date(t.dueDate) : (t.createdAt ? new Date(t.createdAt) : null));
                    const isTaskInFilter = (t) => {
                        if (analyticsTimeFilter === 'all') return true;
                        const taskDate = getTaskDate(t);
                        if (!taskDate || isNaN(taskDate.getTime())) return false;
                        if (analyticsTimeFilter === 'last30') {
                            const thirtyDaysAgo = new Date();
                            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                            return taskDate >= thirtyDaysAgo;
                        }
                        const ym = `${taskDate.getFullYear()}-${String(taskDate.getMonth() + 1).padStart(2, '0')}`;
                        return ym === analyticsTimeFilter;
                    };
                    const isExamInFilter = (ex) => {
                        if (analyticsTimeFilter === 'all') return true;
                        if (!ex.date) return false;
                        const exDate = new Date(ex.date);
                        if (!exDate || isNaN(exDate.getTime())) return false;
                        if (analyticsTimeFilter === 'last30') {
                            const thirtyDaysAgo = new Date();
                            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                            return exDate >= thirtyDaysAgo;
                        }
                        const ym = `${exDate.getFullYear()}-${String(exDate.getMonth() + 1).padStart(2, '0')}`;
                        return ym === analyticsTimeFilter;
                    };

                    const completedTasks = rawCompletedTasks.filter(isTaskInFilter);
                    const exams = rawExams.filter(isExamInFilter);
                    const printFilterLabel = analyticsTimeFilter === 'all' 
                        ? 'כל הזמנים' 
                        : analyticsTimeFilter === 'last30' 
                            ? '30 ימים אחרונים' 
                            : formatMonthLabel(analyticsTimeFilter);

                    const onTimeCount = completedTasks.filter(t => {
                        if (!t.dueDate || !t.dueTime || !t.completedAt) return true;
                        return new Date(t.completedAt) <= new Date(`${t.dueDate}T${t.dueTime}`);
                    }).length;
                    const onTimePct = completedTasks.length > 0 ? Math.round((onTimeCount / completedTasks.length) * 100) : 100;
                    
                    const subjectStats = (activeUserData.subjects || []).map(sub => {
                        const subTasks = completedTasks.filter(t => !t.isLessonLog && t.subjectId === sub.id && t.understandingRating);
                        const ratings = subTasks.map(t => t.understandingRating);
                        const avg = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
                        return {
                            ...sub,
                            completedCount: subTasks.length,
                            avgRating: avg ? parseFloat(avg) : null
                        };
                    }).filter(s => s.completedCount > 0).sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));

                    const allRatings = completedTasks.filter(t => !t.isLessonLog && t.understandingRating).map(t => t.understandingRating);
                    const overallAvgRating = allRatings.length > 0 ? (allRatings.reduce((a, b) => a + b, 0) / allRatings.length).toFixed(1) : null;

                    const gradedExams = exams.filter(e => e.grade);
                    const examAvg = gradedExams.length > 0 ? (gradedExams.reduce((sum, e) => sum + Number(e.grade), 0) / gradedExams.length).toFixed(1) : null;

                    const hourBuckets = {
                        morning: { label: 'בוקר (06:00-12:00)', count: 0 },
                        afternoon: { label: 'צהריים (12:00-17:00)', count: 0 },
                        evening: { label: 'ערב (17:00-21:00)', count: 0 },
                        night: { label: 'לילה (21:00-06:00)', count: 0 }
                    };
                    completedTasks.forEach(t => {
                        if (t.completedAt) {
                            const h = new Date(t.completedAt).getHours();
                            if (h >= 6 && h < 12) hourBuckets.morning.count++;
                            else if (h >= 12 && h < 17) hourBuckets.afternoon.count++;
                            else if (h >= 17 && h < 21) hourBuckets.evening.count++;
                            else hourBuckets.night.count++;
                        }
                    });

                    return (
                        <div id="print-area" className="bg-white text-black p-8 font-sans text-right" dir="rtl">
                            <div className="text-center mb-6 border-b-2 border-stone-800 pb-4">
                                <div className="flex items-center justify-between text-xs text-stone-500 font-bold mb-1">
                                    <span>StudyStreak Pro • כיתה י"ב</span>
                                    <span>הופק בתאריך: {new Date().toLocaleDateString('he-IL')}</span>
                                </div>
                                <h1 className="text-2xl font-black text-stone-900 mb-1">דוח סטטיסטיקה מקיף ותמונת מצב לימודית</h1>
                                <p className="text-base font-bold text-stone-600">תלמידה: {activeUserData.name} • טווח נתונים: {printFilterLabel}</p>
                            </div>

                            <div className="grid grid-cols-4 gap-3 mb-6">
                                <div className="bg-stone-50 p-4 rounded-xl text-center border border-stone-200">
                                    <div className="text-xs text-stone-500 font-bold mb-1 uppercase">משימות שהוגשו</div>
                                    <div className="text-2xl font-black text-purple-700">{completedTasks.length}</div>
                                </div>
                                <div className="bg-stone-50 p-4 rounded-xl text-center border border-stone-200">
                                    <div className="text-xs text-stone-500 font-bold mb-1 uppercase">הגשה בזמן</div>
                                    <div className="text-2xl font-black text-emerald-600">{onTimePct}%</div>
                                </div>
                                <div className="bg-stone-50 p-4 rounded-xl text-center border border-stone-200">
                                    <div className="text-xs text-stone-500 font-bold mb-1 uppercase">מדד הבנה ממוצע</div>
                                    <div className="text-2xl font-black text-amber-600">{overallAvgRating ? `${overallAvgRating}/5` : '-'}</div>
                                </div>
                                <div className="bg-stone-50 p-4 rounded-xl text-center border border-stone-200">
                                    <div className="text-xs text-stone-500 font-bold mb-1 uppercase">ממוצע מבחנים</div>
                                    <div className="text-2xl font-black text-indigo-600">{examAvg ? `${examAvg}` : '-'}</div>
                                </div>
                            </div>

                            <div className="mb-6">
                                <h2 className="text-base font-bold bg-stone-100 p-2.5 mb-3 rounded-lg border border-stone-200 flex items-center justify-between">
                                    <span>⭐️ דירוג הבנה לפי מקצועות (שיעורי בית בלבד)</span>
                                    <span className="text-xs font-normal text-stone-500">*תיעוד שיעור ללא משימות אינו נכלל</span>
                                </h2>
                                {subjectStats.length > 0 ? (
                                    <table className="w-full text-right border-collapse text-sm">
                                        <thead>
                                            <tr className="border-b-2 border-stone-300 text-stone-600 text-xs">
                                                <th className="py-2 px-2">מקצוע</th>
                                                <th className="py-2 px-2 text-center">משימות שהוגשו</th>
                                                <th className="py-2 px-2 text-center">דירוג הבנה ממוצע</th>
                                                <th className="py-2 px-2 text-center">סטטוס שליטה</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-stone-200">
                                            {subjectStats.map(s => (
                                                <tr key={s.id}>
                                                    <td className="py-2 px-2 font-bold text-stone-800">{s.emoji || '📖'} {s.name}</td>
                                                    <td className="py-2 px-2 text-center font-medium">{s.completedCount}</td>
                                                    <td className="py-2 px-2 text-center font-black text-purple-700">{s.avgRating ? `${s.avgRating} / 5` : '-'}</td>
                                                    <td className="py-2 px-2 text-center text-xs font-semibold">
                                                        {s.avgRating >= 4 ? '🟢 שולטת היטב' : s.avgRating >= 3 ? '🟡 טוב' : '🔴 דורש חיזוק'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <p className="text-stone-500 text-sm italic py-2">טרם הושלמו שיעורי בית עם דירוג הבנה.</p>
                                )}
                            </div>

                            <div className="mb-6">
                                <h2 className="text-base font-bold bg-stone-100 p-2.5 mb-3 rounded-lg border border-stone-200">
                                    🕒 התפלגות שעות פעילות והגשות
                                </h2>
                                <div className="grid grid-cols-4 gap-2 text-center text-xs">
                                    {Object.entries(hourBuckets).map(([key, bucket]) => (
                                        <div key={key} className="bg-stone-50 p-2.5 rounded-lg border border-stone-200">
                                            <div className="text-stone-500 font-bold">{bucket.label}</div>
                                            <div className="text-lg font-black text-stone-800 mt-1">{bucket.count} משימות</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {exams.length > 0 && (
                                <div className="mb-6">
                                    <h2 className="text-base font-bold bg-stone-100 p-2.5 mb-3 rounded-lg border border-stone-200">
                                        📝 לוח מבחנים וציונים
                                    </h2>
                                    <table className="w-full text-right border-collapse text-sm">
                                        <thead>
                                            <tr className="border-b-2 border-stone-300 text-stone-600 text-xs">
                                                <th className="py-1.5 px-2">בחינה</th>
                                                <th className="py-1.5 px-2">תאריך</th>
                                                <th className="py-1.5 px-2 text-center">ציון</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-stone-200">
                                            {exams.map(e => {
                                                const sub = (activeUserData.subjects || []).find(s => s.id === e.subjectId);
                                                return (
                                                    <tr key={e.id}>
                                                        <td className="py-1.5 px-2 font-bold text-stone-800">{sub?.emoji || ''} {e.examName} ({sub?.name || 'כללי'})</td>
                                                        <td className="py-1.5 px-2 text-stone-600 font-medium" dir="rtl">{e.date ? new Date(e.date).toLocaleDateString('he-IL') : '-'}</td>
                                                        <td className="py-1.5 px-2 text-center font-black text-indigo-600">{e.grade ? e.grade : 'עתידי'}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="text-center mt-8 text-xs text-stone-400 font-bold border-t border-stone-200 pt-4">
                                הופק מ-StudyStreak Pro • מותאם לדף A4
                            </div>
                        </div>
                    );
                }
            }


            if (!globalState.activeUser || !activeUserData) {
                return (
                    <div className="min-h-screen flex items-center justify-center bg-[#FAFAFA] p-4" dir="rtl">
                        <div className="bg-white p-8 md:p-10 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] w-full max-w-sm border border-stone-100 relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-purple-100 rounded-full blur-3xl -mr-16 -mt-16 opacity-60 pointer-events-none"></div>
                            <div className="absolute bottom-0 left-0 w-32 h-32 bg-rose-100 rounded-full blur-3xl -ml-16 -mb-16 opacity-60 pointer-events-none"></div>
                            
                            <div className="text-center mb-8 relative z-10">
                                <span className="text-5xl inline-block mb-4 drop-shadow-sm">✨</span>
                                <h1 className="text-3xl font-bold text-stone-800 tracking-tight">StudyStreak Pro</h1>
                                <p className="text-sm text-stone-500 font-medium mt-1">מנהלים את הלמידה בסטייל</p>
                            </div>
                            
                            {toastMessage && (
                                <div className={`mb-6 p-3 text-sm rounded-xl font-bold text-center relative z-10 ${
                                    toastMessage.type === 'success' ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' :
                                    toastMessage.type === 'error' ? 'bg-rose-50 text-rose-600 border border-rose-100' : 'bg-amber-50 text-amber-600 border border-amber-100'
                                }`}>
                                    {toastMessage.text}
                                </div>
                            )}


                            <form onSubmit={handleLogin} className="space-y-5 relative z-10">
                                <div>
                                    <label className="block text-xs text-right font-bold text-stone-500 mb-1.5 uppercase tracking-wide">שם משתמש / אימייל</label>
                                    <input name="username" type="text" dir="rtl" required className="w-full text-right p-4 bg-stone-50 rounded-xl border border-stone-200 text-sm focus:ring-2 focus:ring-purple-200 focus:border-purple-400 focus:bg-white transition-all outline-none" placeholder="הקלידי שם..." />
                                </div>
                                <div>
                                    <label className="block text-xs text-right font-bold text-stone-500 mb-1.5 uppercase tracking-wide">סיסמה</label>
                                    <input name="password" type="password" dir="rtl" required className="w-full text-right p-4 bg-stone-50 rounded-xl border border-stone-200 text-sm focus:ring-2 focus:ring-purple-200 focus:border-purple-400 focus:bg-white transition-all outline-none" placeholder="הקלידי סיסמה..." />
                                </div>
                                <button type="submit" className="w-full py-4 bg-gradient-to-r from-purple-500 to-fuchsia-500 hover:from-purple-600 hover:to-fuchsia-600 text-white rounded-xl font-bold shadow-md shadow-purple-500/20 transition-all mt-4 text-sm tracking-wide active:scale-95">
                                    כניסה / הרשמה (מסונכרן לענן)
                                </button>
                            </form>
                            <div className="text-center text-[11px] text-stone-400 mt-6 font-medium relative z-10">
                                משתמשת חדשה? הקלידי שם וסיסמה והחשבון ייווצר בענן.
                            </div>
                        </div>
                    </div>
                );
            }


            const Navigation = () => {
                const isExtendedTabActive = ['analytics', 'lesson_log', 'schedule', 'profile', 'settings'].includes(activeTab);
                const extendedTabName = 
                    activeTab === 'analytics' ? 'סטטיסטיקה 📊' :
                    activeTab === 'lesson_log' ? 'יומן שיעורים 📖' :
                    activeTab === 'schedule' ? 'לו"ז וזמנים 📅' :
                    activeTab === 'profile' ? 'פרופיל 👤' :
                    activeTab === 'settings' ? 'הגדרות ⚙️' : 'עוד... ⋯';

                const navItems = [
                    { id: 'dashboard', label: 'ראשי', icon: IconSparkle },
                    { id: 'tasks', label: 'משימות', icon: IconList },
                    { id: 'exam_prep', label: 'הכנה למבחנים', icon: IconBrain },
                    { id: 'social', label: 'חברות 👑', icon: IconUsers },
                    { id: 'more', label: extendedTabName, isMore: true }
                ];

                return (
                    <nav className="flex md:flex-col gap-2 flex-1 w-full hide-scrollbar">
                        {navItems.map(item => {
                            const Icon = item.icon;
                            const isActive = item.isMore ? isExtendedTabActive : activeTab === item.id;
                            return (
                                <button 
                                    key={item.id} 
                                    onClick={() => {
                                        if (item.isMore) {
                                            setIsMoreMenuOpen(true);
                                        } else {
                                            setActiveTab(item.id);
                                        }
                                    }}
                                    className={`flex flex-col md:flex-row items-center md:justify-start justify-center gap-1.5 md:gap-3 px-4 py-3 md:py-3.5 rounded-2xl text-[11px] md:text-sm font-semibold transition-all flex-shrink-0 min-w-[72px] md:min-w-0 active:scale-95 ${
                                        isActive ? 'bg-purple-50 text-purple-700 font-bold shadow-xs' : 'text-stone-500 hover:bg-stone-50 hover:text-stone-800'
                                    }`}>
                                    {Icon ? (
                                        <Icon className={`w-5 h-5 md:w-5 md:h-5 ${isActive ? 'text-purple-600' : 'text-stone-400'}`} />
                                    ) : (
                                        <span className={`text-base font-black leading-none ${isActive ? 'text-purple-600' : 'text-stone-400'}`}>⋯</span>
                                    )}
                                    <span className="whitespace-nowrap">{item.label}</span>
                                </button>
                            );
                        })}
                    </nav>
                );
            };


            const myLevel = getUserLevel(activeUserData.totalPoints);
            
            // שימוש בטוח ברשימות כדי שלא יקרוס
            const safePointsHistory = activeUserData.pointsHistory || [];
            const safeStreakHistory = activeUserData.streakHistory || [];


            return (
                <div className="min-h-screen flex flex-col md:flex-row pb-24 md:pb-0 no-print" dir="rtl">
                    
                    {toastMessage && (
                        <div className="fixed top-safe-top left-1/2 -translate-x-1/2 mt-4 z-[80] max-w-sm w-11/12 animate-[bounce_0.5s_ease-out]">
                            <div className={`flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-lg border text-sm font-semibold ${
                                toastMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                                toastMessage.type === 'error' ? 'bg-rose-50 text-rose-700 border-rose-200' : 
                                toastMessage.type === 'info' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' :
                                'bg-amber-50 text-amber-700 border-amber-200'
                            }`}>
                                <span>{toastMessage.type === 'success' ? '✨' : toastMessage.type === 'info' ? '💬' : '⚠️'}</span>
                                <p className="flex-1">{toastMessage.text}</p>
                            </div>
                        </div>
                    )}


                    <aside className="hidden md:flex flex-col w-72 bg-white/80 backdrop-blur-xl border-l border-stone-200 p-6 sticky top-0 h-screen overflow-y-auto custom-scrollbar">
                        <div className="flex items-center justify-between mb-8">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-gradient-to-br from-purple-100 to-rose-100 rounded-xl flex items-center justify-center text-xl shadow-sm">✨</div>
                                <div>
                                    <h1 className="text-lg font-bold text-stone-800 leading-tight tracking-tight">StudyStreak</h1>
                                    <span className="text-xs text-stone-500 font-medium block mt-0.5">היי, {activeUserData.name}</span>
                                </div>
                            </div>
                        </div>


                        <div className="bg-gradient-to-br from-stone-800 to-stone-900 text-white p-5 rounded-3xl mb-8 cursor-pointer hover:shadow-lg transition-all shadow-md group relative active:scale-95" 
                             onClick={() => toggleModal('streakHistory', true)}>
                            <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none"></div>
                            <div className="relative z-10 flex justify-between items-center mb-1">
                                <span className="text-xs text-stone-400 font-medium">מד רצף משימות</span>
                            </div>
                            <div className="text-4xl font-black text-purple-300 relative z-10 group-hover:scale-105 transition-transform origin-right flex items-center gap-2 drop-shadow-md pb-1">
                                <span>{activeUserData.taskStreak}</span> <span className="text-3xl drop-shadow-md">🔥</span>
                            </div>
                        </div>

                        <Navigation />
                        
                        <div className="mt-auto pt-6">
                            <button onClick={() => { setTaskFormHasHW(true); setTaskGivenDate(new Date().toISOString().split('T')[0]); toggleModal('task', true); }} className="w-full py-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-2xl font-bold shadow-md shadow-purple-500/20 flex items-center justify-center gap-2 text-sm transition-all active:scale-95">
                                <IconPlus className="w-4 h-4" /> הוספת שיעור/משימה
                            </button>
                            <button onClick={handleLogout} className="w-full mt-3 py-3 text-sm text-stone-500 hover:text-rose-600 font-semibold bg-stone-50 hover:bg-rose-50 rounded-2xl transition-colors flex items-center justify-center gap-2 active:scale-95">
                                התנתקות
                            </button>
                        </div>
                    </aside>


                    <header className="md:hidden flex justify-between items-center bg-white/90 backdrop-blur-md p-4 sticky top-0 z-40 border-b border-stone-100 pt-safe-top">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 bg-gradient-to-br from-purple-100 to-rose-100 rounded-lg flex items-center justify-center text-sm shadow-sm">✨</div>
                            <div className="font-bold text-lg text-stone-800 tracking-tight">StudyStreak</div>
                        </div>
                        <div className="flex gap-2 items-center">
                            <button onClick={()=>toggleModal('streakHistory', true)} className="bg-purple-50 text-purple-700 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 active:scale-95">
                                <span>🔥</span> {activeUserData.taskStreak}
                            </button>
                            <button onClick={handleLogout} className="bg-stone-50 text-stone-500 p-2 rounded-xl active:bg-stone-100 active:scale-95"><IconX className="w-4 h-4"/></button>
                        </div>
                    </header>
                    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-stone-200 z-40 no-print shadow-[0_-10px_40px_rgba(0,0,0,0.05)] pb-safe-bottom overflow-x-auto hide-scrollbar flex px-2 pt-2">
                        <Navigation />
                    </nav>


                    <main className="flex-1 w-full max-w-5xl mx-auto p-4 md:p-6 lg:p-8 relative z-10">
                        
                        {}
                        {activeTab === 'dashboard' && (
                            <div className="space-y-6 animate-[fadeIn_0.3s_ease-out]">
                                <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                    <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] border border-stone-100 cursor-pointer hover:border-purple-200 transition-colors group flex flex-col justify-between active:scale-95" onClick={() => toggleModal('streakHistory', true)}>
                                        <div className="text-stone-400 text-xs font-semibold mb-2 flex items-center justify-between">
                                            <span>מד משימות</span>
                                            <IconFlame className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform" />
                                        </div>
                                        <div>
                                            <div className="text-3xl font-bold text-stone-800">{activeUserData.taskStreak}</div>
                                        </div>
                                    </div>
                                    <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] border border-stone-100 cursor-pointer hover:border-purple-200 transition-colors active:scale-95" onClick={() => toggleModal('pointsHistory', true)}>
                                        <div className="text-stone-400 text-xs font-semibold mb-2">נקודות השבוע</div>
                                        <div className="text-3xl font-bold text-purple-600 text-right" dir="ltr">{activeUserData.weeklyPoints}</div>
                                    </div>
                                    <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] border border-stone-100 cursor-pointer hover:border-purple-200 transition-colors active:scale-95" onClick={() => toggleModal('pointsHistory', true)}>
                                        <div className="text-stone-400 text-xs font-semibold mb-2">סה"כ נקודות</div>
                                        <div className="text-3xl font-bold text-emerald-600 text-right" dir="ltr">{activeUserData.totalPoints}</div>
                                    </div>
                                    <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] border border-stone-100 cursor-pointer hover:border-purple-200 transition-colors active:scale-95" onClick={() => setActiveTab('exam_prep')}>
                                        <div className="text-stone-400 text-xs font-semibold mb-2">תרגילים בארכיון</div>
                                        <div className="text-3xl font-bold text-rose-500">{activeUserData.tasks.filter(t => t.completed && t.hardExercises && t.hardExercises.trim() !== '').length}</div>
                                    </div>
                                </section>


                                <section>
                                    <div className="flex justify-between items-end mb-4 px-1">
                                        <div>
                                            <h3 className="font-bold text-lg text-stone-800 tracking-tight">הבאים בתור לביצוע</h3>
                                            <p className="text-sm text-stone-500 font-medium">המשימות הקרובות ביותר שלך.</p>
                                        </div>
                                        <button onClick={()=>setActiveTab('tasks')} className="text-sm font-semibold text-purple-600 hover:text-purple-700 bg-purple-50 px-3 py-1.5 rounded-xl transition-colors active:scale-95">לכל המשימות ←</button>
                                    </div>
                                    
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {activeUserData.tasks
                                            .filter(t => !t.completed)
                                            .sort((a,b) => {
                                                const timeA = (a.dueDate && a.dueTime) ? new Date(`${a.dueDate}T${a.dueTime}`).getTime() : Infinity;
                                                const timeB = (b.dueDate && b.dueTime) ? new Date(`${b.dueDate}T${b.dueTime}`).getTime() : Infinity;
                                                return timeA - timeB;
                                            })
                                            .slice(0,4).map(task => {
                                            const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                                            const isLate = task.dueDate && task.dueTime && new Date() > new Date(`${task.dueDate}T${task.dueTime}`);
                                            const countdown = task.dueDate ? getTaskCountdown(task.dueDate, task.dueTime) : null;
                                            return (
                                                <div key={task.id} className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100 flex flex-col justify-between hover:shadow-[0_8px_30px_-4px_rgba(0,0,0,0.08)] transition-all gap-4">
                                                    <div>
                                                        <div className="flex justify-between items-start mb-3 flex-wrap gap-2">
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className="text-xs px-2.5 py-1 rounded-lg font-bold shadow-sm" style={{backgroundColor: sub?.color || '#f5f5f4', color: sub ? '#fff' : '#57534e'}}>
                                                                    {sub?.emoji} {sub?.name || 'ללא מקצוע'}
                                                                </span>
                                                                {task.remindersEnabled && (
                                                                    <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-lg border border-purple-200 flex items-center gap-1 shadow-xs">
                                                                        <span>🔔</span> תזכורות
                                                                    </span>
                                                                )}
                                                                {task.whatsappRemindersEnabled && (
                                                                    <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-lg border border-emerald-200 flex items-center gap-1 shadow-xs">
                                                                        <span>💬</span> וואטסאפ
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                {countdown && (
                                                                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border shadow-xs ${countdown.badgeClass}`}>
                                                                        {countdown.text}
                                                                    </span>
                                                                )}
                                                                <span className={`text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1.5 border ${isLate ? 'text-rose-600 bg-rose-50 border-rose-100/50' : 'text-stone-600 bg-stone-50 border-stone-200/50'}`}>
                                                                    <IconCalendar className="w-3.5 h-3.5"/> <span dir="rtl">{task.dueDate ? `${new Date(task.dueDate).toLocaleDateString('he-IL', {day:'2-digit', month:'2-digit'})} • ${task.startTime ? `מ-${task.startTime} עד ` : ''}${task.dueTime}` : 'לא הוגדר'}</span>
                                                                </span>
                                                            </div>
                                                        </div>
                                                        <div className="font-bold text-stone-800 text-base">{task.title}</div>
                                                        {task.lessonTopic && <div className="text-sm text-stone-500 mt-1">{task.lessonTopic}</div>}
                                                    </div>
                                                    <div className="flex gap-2 w-full mt-1 items-center">
                                                        <button onClick={() => { setActiveTask(task); setLateReason(''); setOtherLateReason(''); toggleModal('complete', true); }} className={`flex-1 border px-4 py-3 rounded-2xl transition-all font-bold text-sm flex items-center justify-center gap-2 active:scale-95 shadow-xs ${isLate ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100' : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200'}`}>
                                                            <IconCheck className="w-4 h-4 text-emerald-600"/> {isLate ? 'הגשה באיחור' : 'סיימתי!'}
                                                        </button>
                                                        <button onClick={() => setTaskActionsMenu(task)} className="px-4 py-3 bg-stone-50 hover:bg-stone-100 text-stone-600 border border-stone-200 rounded-2xl transition-all font-bold text-sm flex items-center justify-center gap-1.5 active:scale-95 shadow-xs" title="אפשרויות נוספות">
                                                            <span className="text-base font-black leading-none">⋯</span>
                                                            <span className="text-xs">אפשרויות</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                        {activeUserData.tasks.filter(t => !t.completed).length === 0 && (
                                            <div className="col-span-full text-center p-8 bg-white rounded-3xl text-stone-400 border border-stone-200 border-dashed">
                                                <div className="text-4xl mb-3">🎉</div>
                                                <div className="text-base font-bold text-stone-600">אין משימות פתוחות! איזה כיף.</div> 
                                            </div>
                                        )}
                                    </div>
                                </section>
                            </div>
                        )}


                        {}
                        {activeTab === 'tasks' && (() => {
                            const mainTasksList = activeUserData.tasks.filter(t => !t.isLessonLog || (t.isLessonLog && !t.completed));
                            const taskSubjects = [...new Set(mainTasksList.map(t => t.subjectId))].map(id => activeUserData.subjects.find(s => s.id === id)).filter(Boolean);
                            
                            const sortedFilteredTasks = mainTasksList
                                .filter(t => taskFilter === 'all' ? true : t.subjectId === taskFilter)
                                .sort((a, b) => {
                                    if (a.completed && !b.completed) return 1;
                                    if (!a.completed && b.completed) return -1;
                                    if (!a.completed && !b.completed) {
                                        const timeA = (a.dueDate && a.dueTime) ? new Date(`${a.dueDate}T${a.dueTime}`).getTime() : Infinity;
                                        const timeB = (b.dueDate && b.dueTime) ? new Date(`${b.dueDate}T${b.dueTime}`).getTime() : Infinity;
                                        return timeA - timeB;
                                    }
                                    if (a.completed && b.completed) {
                                        return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
                                    }
                                    return 0;
                                });


                            return (
                            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
                                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 bg-white p-5 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                    <div>
                                        <h2 className="text-xl font-bold text-stone-800 tracking-tight">רשימת משימות ושיעורי בית</h2>
                                        <p className="text-sm text-stone-500 mt-1">מסודרות לפי רמת הדחיפות.</p>
                                    </div>
                                    <button onClick={() => { setTaskFormHasHW(true); setTaskGivenDate(new Date().toISOString().split('T')[0]); toggleModal('task', true); }} className="bg-stone-800 text-white px-5 py-3 rounded-2xl text-sm font-bold shadow-md hover:bg-stone-900 transition-colors flex items-center justify-center gap-2 active:scale-95">
                                        <IconPlus className="w-4 h-4"/> הוספת חדש
                                    </button>
                                </div>
                                
                                {taskSubjects.length > 0 && (
                                    <div className="flex flex-wrap gap-2 pb-1">
                                        <button 
                                            onClick={() => setTaskFilter('all')}
                                            className={`px-4 py-2 rounded-full text-sm font-bold transition-all border active:scale-95 ${taskFilter === 'all' ? 'bg-stone-800 text-white border-stone-800 shadow-sm' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                                        >
                                            הכל ביחד
                                        </button>
                                        {taskSubjects.map(sub => (
                                            <button 
                                                key={sub.id}
                                                onClick={() => setTaskFilter(sub.id)}
                                                className={`px-4 py-2 rounded-full text-sm font-bold transition-all border flex items-center gap-1.5 active:scale-95 ${taskFilter === sub.id ? 'bg-purple-100 text-purple-800 border-purple-200 shadow-sm' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                                            >
                                                <span>{sub.emoji}</span> {sub.name}
                                            </button>
                                        ))}
                                    </div>
                                )}


                                <div className="grid grid-cols-1 gap-4">
                                    {sortedFilteredTasks.map(task => {
                                        const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                                        const isLate = !task.completed && task.dueDate && task.dueTime && new Date() > new Date(`${task.dueDate}T${task.dueTime}`);
                                        return (
                                            <div key={task.id} className={`p-4 rounded-3xl border transition-all ${task.completed ? 'bg-stone-50/50 border-stone-200 opacity-75' : isLate ? 'bg-rose-50/30 border-rose-200' : 'bg-white border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] hover:shadow-md'}`}>
                                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                            <span className="text-xs px-2 py-1 rounded-lg font-bold shadow-sm" style={{backgroundColor: sub?.color || '#f5f5f4', color: sub ? '#fff' : '#57534e'}}>
                                                                {sub?.emoji} {sub?.name || 'כללי'}
                                                            </span>
                                                            {task.isExamPrep && (
                                                                <span className="text-[10px] font-bold text-white bg-gradient-to-r from-indigo-500 to-purple-500 px-2 py-1 rounded-lg shadow-sm flex items-center gap-1">
                                                                    <span>🎯</span> סשן למידה
                                                                </span>
                                                            )}
                                                            {task.remindersEnabled && !task.completed && (
                                                                <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-lg border border-purple-200 flex items-center gap-1 shadow-xs">
                                                                    <span>🔔</span> תזכורות פעילות
                                                                </span>
                                                            )}
                                                            {task.whatsappRemindersEnabled && !task.completed && (
                                                                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-lg border border-emerald-200 flex items-center gap-1 shadow-xs">
                                                                    <span>💬</span> תזכורות וואטסאפ
                                                                </span>
                                                            )}
                                                            {!task.isLessonLog && !task.completed && task.dueDate && (() => {
                                                                const countdown = getTaskCountdown(task.dueDate, task.dueTime);
                                                                return (
                                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                                        {countdown && (
                                                                            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border shadow-xs ${countdown.badgeClass}`}>
                                                                                {countdown.text}
                                                                            </span>
                                                                        )}
                                                                        <span className={`text-xs font-medium px-2 py-1 rounded-lg ${isLate ? 'text-rose-600 bg-rose-100 border border-rose-200 font-bold' : 'text-stone-500 bg-stone-100'}`}>
                                                                            {isLate ? (task.isExamPrep ? 'זמן הלמידה עבר: ' : 'זמן ההגשה עבר: ') : (task.isExamPrep ? 'מתוכנן ל: ' : 'להגשה: ')} <span dir="rtl">{new Date(task.dueDate).toLocaleDateString('he-IL')} {task.startTime ? `מ-${task.startTime} עד ` : ''}{task.dueTime}</span>
                                                                        </span>
                                                                    </div>
                                                                );
                                                            })()}
                                                            {task.completed && !task.isLessonLog && !task.givenUp && (
                                                                <span className="text-xs font-medium text-stone-500 bg-white border border-stone-200 px-2 py-1 rounded-lg shadow-sm">
                                                                    הושלם ב: <span dir="ltr">{new Date(task.completedAt).toLocaleString('he-IL', {dateStyle: 'short', timeStyle: 'short'})}</span>
                                                                </span>
                                                            )}
                                                            {task.givenUp && (
                                                                <span className="text-xs font-bold text-white bg-stone-400 px-2 py-1 rounded-lg shadow-sm">
                                                                    🏳️ ויתרתי
                                                                </span>
                                                            )}
                                                            {task.lateReason && !task.givenUp && (
                                                                <span className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded-lg border border-rose-100">
                                                                    סיבת איחור: {task.lateReason}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <h3 className={`font-bold text-lg ${task.completed ? 'line-through text-stone-400' : 'text-stone-800'}`}>{task.title}</h3>
                                                        <div className="text-sm text-stone-500 mt-1 font-medium">{task.lessonTopic && `נושא: ${task.lessonTopic}`}</div>
                                                        
                                                        {task.completed && !task.isLessonLog && !task.givenUp && (
                                                            <div className="mt-4 text-xs space-y-2 border-t border-stone-200/50 pt-3 flex flex-wrap gap-2">
                                                                <span className="bg-white border border-stone-200 text-stone-600 px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1 shadow-sm">
                                                                    הבנה: {task.understandingRating}/5
                                                                </span>
                                                                <span className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1 shadow-sm ${task.pointsEarned > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'}`}>
                                                                    {task.pointsEarned > 0 ? '+'+task.pointsEarned : task.pointsEarned} נק'
                                                                </span>
                                                                {task.hardExercises && <span className="text-rose-700 font-semibold bg-rose-50 px-3 py-1.5 rounded-lg border border-rose-100 shadow-sm">קשה: {task.hardExercises}</span>}
                                                            </div>
                                                        )}
                                                    </div>
                                                    
                                                    <div className="flex md:flex-col gap-2 w-full md:w-44 shrink-0 border-t md:border-t-0 md:border-r border-stone-100 pt-3 md:pt-0 md:pr-4">
                                                        {!task.completed ? (
                                                            <div className="flex gap-2 w-full items-center">
                                                                <button onClick={() => { setActiveTask(task); setLateReason(''); setOtherLateReason(''); toggleModal('complete', true); }} className={`flex-1 border px-3 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-1.5 active:scale-95 shadow-xs ${isLate ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100' : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200'}`}>
                                                                    <IconCheck className="w-4 h-4 text-emerald-600"/> {isLate ? 'הגשה באיחור' : 'סיימתי!'}
                                                                </button>
                                                                <button onClick={() => setTaskActionsMenu(task)} className="px-3 py-2.5 bg-stone-50 hover:bg-stone-100 text-stone-600 border border-stone-200 rounded-xl transition-all font-bold text-sm flex items-center justify-center gap-1 active:scale-95 shadow-xs" title="אפשרויות נוספות">
                                                                    <span className="text-base font-black leading-none">⋯</span>
                                                                    <span className="text-xs">אפשרויות</span>
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <button onClick={() => handleDeleteTask(task.id)} className="w-full bg-stone-50 text-stone-500 border border-stone-200 p-2.5 rounded-xl hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors flex items-center justify-center gap-2 text-sm font-medium active:scale-95">
                                                                <IconTrash className="w-4 h-4"/> מחיקה מהרשימה
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                    {sortedFilteredTasks.length === 0 && <div className="text-stone-400 text-base font-medium text-center py-16 bg-white rounded-3xl border border-stone-200 border-dashed">אין משימות ברשימה. הוספי משימה חדשה כדי להתחיל!</div>}
                                </div>
                            </div>
                            )
                        })()}


                        {}
                        {activeTab === 'lesson_log' && (() => {
                            const lessonTasks = activeUserData.tasks.filter(t => t.lessonTopic && t.lessonTopic.trim() !== '' && !t.isExamPrep);
                            const logSubjects = [...new Set(lessonTasks.map(t => t.subjectId))].map(id => activeUserData.subjects.find(s => s.id === id)).filter(Boolean);
                            const filteredLogs = lessonLogFilter === 'all' ? lessonTasks : lessonTasks.filter(t => t.subjectId === lessonLogFilter);


                            return (
                                <div className="space-y-6 animate-[fadeIn_0.3s_ease-out]">
                                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 bg-white p-6 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                        <div>
                                            <h2 className="text-2xl font-bold text-stone-800 tracking-tight">יומן שיעורים 📚</h2>
                                            <p className="text-sm text-stone-500 mt-1">ריכוז של כל מה שלמדת בכיתה, מסודר לפי תאריכים ומקצועות.</p>
                                        </div>
                                    </div>


                                    {logSubjects.length > 0 && (
                                        <div className="flex flex-wrap gap-2 mb-4 pb-4 border-b border-stone-100">
                                            <button 
                                                onClick={() => setLessonLogFilter('all')}
                                                className={`px-4 py-2.5 rounded-full text-sm font-bold transition-all border active:scale-95 ${lessonLogFilter === 'all' ? 'bg-stone-800 text-white border-stone-800 shadow-sm' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                                            >
                                                הכל ביחד
                                            </button>
                                            {logSubjects.map(sub => (
                                                <button 
                                                    key={sub.id}
                                                    onClick={() => setLessonLogFilter(sub.id)}
                                                    className={`px-4 py-2.5 rounded-full text-sm font-bold transition-all border flex items-center gap-1.5 active:scale-95 ${lessonLogFilter === sub.id ? 'bg-purple-100 text-purple-800 border-purple-200 shadow-sm' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                                                >
                                                    <span>{sub.emoji}</span> {sub.name}
                                                </button>
                                            ))}
                                        </div>
                                    )}


                                    <div className="grid grid-cols-1 gap-4">
                                        {filteredLogs.map(task => {
                                            const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                                            return (
                                                <div key={task.id} className="p-4 rounded-3xl border border-stone-100 bg-white shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] hover:shadow-md transition-all flex flex-col md:flex-row md:items-center justify-between gap-4">
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-2 mb-3 flex-wrap">
                                                            <span className="text-xs px-2 py-1 rounded-lg font-bold shadow-sm" style={{backgroundColor: sub?.color || '#f5f5f4', color: sub ? '#fff' : '#57534e'}}>
                                                                {sub?.emoji} {sub?.name || 'כללי'}
                                                            </span>
                                                            <span className="text-xs font-medium text-stone-500 bg-stone-50 px-2 py-1 rounded-lg border border-stone-100">
                                                                נלמד ב: <span dir="ltr">{new Date(task.givenDate || task.createdAt).toLocaleDateString('he-IL')}</span>
                                                            </span>
                                                            {task.isLessonLog && (
                                                                <span className="text-[10px] font-bold text-purple-600 bg-purple-50 px-2 py-1 rounded-lg border border-purple-100">
                                                                    (סומן ללא שיעורי בית)
                                                                </span>
                                                            )}
                                                        </div>
                                                        <h3 className="font-bold text-lg text-stone-800">{task.lessonTopic}</h3>
                                                        {!task.isLessonLog && <div className="text-sm text-stone-500 mt-1">מתוך משימה: {task.title}</div>}
                                                    </div>
                                                    <div className="flex gap-2 shrink-0 border-t md:border-t-0 md:border-r border-stone-100 pt-3 md:pt-0 md:pr-4">
                                                        <button onClick={() => handleRemoveFromLessonLog(task.id)} className="bg-stone-50 text-stone-500 border border-stone-200 px-4 py-3 rounded-xl hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors flex items-center justify-center gap-2 text-sm font-medium w-full md:w-auto active:scale-95">
                                                            <IconTrash className="w-4 h-4"/> מחיקה מהיומן
                                                        </button>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                        {filteredLogs.length === 0 && <div className="text-stone-400 text-base font-medium text-center py-16 bg-white rounded-3xl border border-stone-200 border-dashed">יומן השיעורים ריק. תעדי שיעור חדש!</div>}
                                    </div>
                                </div>
                            );
                        })()}


                        {}
                        {activeTab === 'settings' && (
                            <div className="space-y-6 max-w-4xl mx-auto animate-[fadeIn_0.3s_ease-out]">
                                {/* WhatsApp Integration Card */}
                                <div className="bg-gradient-to-br from-emerald-500/10 via-teal-500/5 to-white p-6 rounded-3xl border border-emerald-200 shadow-[0_4px_20px_-4px_rgba(16,185,129,0.1)]">
                                    <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 mb-6 pb-4 border-b border-emerald-100">
                                        <div className="flex items-center gap-3">
                                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-500 text-white flex items-center justify-center text-2xl shadow-md">💬</div>
                                            <div>
                                                <h2 className="text-xl font-bold text-stone-800 tracking-tight">הגדרות וואטסאפ: תזכורות ודוחות הורים</h2>
                                                <p className="text-xs text-stone-500 mt-0.5">תזכורות מוטיבציה שקטות לפי הלו"ז ודוחות שבועיים אוטומטיים בכל מוצאי שבת</p>
                                            </div>
                                        </div>
                                        {activeUserData.whatsappGateway?.instanceId && (
                                            <span className="px-3 py-1.5 rounded-xl bg-emerald-100 text-emerald-800 font-bold text-xs flex items-center gap-1.5 border border-emerald-200 w-fit">
                                                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> מחובר ל-Gateway (שליחה ברקע פעילה!)
                                            </span>
                                        )}
                                    </div>

                                    {/* Phone Inputs */}
                                    <div className="space-y-4 mb-6">
                                        {/* Student Phone */}
                                        <div className="bg-white p-4 rounded-2xl border border-emerald-100 shadow-xs">
                                            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3">
                                                <div className="flex-1">
                                                    <label className="text-xs font-bold text-stone-700 block mb-1.5 flex items-center gap-1.5">
                                                        <span>📱</span> מספר וואטסאפ של התלמידה (לתזכורות אישיות לשיעורים)
                                                    </label>
                                                    <input 
                                                        type="tel"
                                                        dir="ltr"
                                                        placeholder="לדוגמה: 050-1234567"
                                                        value={activeUserData.phoneNumber || ''}
                                                        onChange={(e) => updateUserData({ phoneNumber: e.target.value })}
                                                        className="w-full p-3 bg-stone-50 border border-stone-200 rounded-xl text-sm font-semibold outline-none focus:border-emerald-500 focus:bg-white transition-all text-right"
                                                    />
                                                </div>
                                                <button 
                                                    onClick={() => handleSendWhatsAppTest('student')}
                                                    className="bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 px-4 py-3 rounded-xl text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1 shrink-0 self-end sm:self-center">
                                                    <span>⚡</span> שליחת בדיקה למספר שלי
                                                </button>
                                            </div>
                                        </div>

                                        {/* Parents Phones */}
                                        <div className="bg-white p-5 rounded-2xl border border-emerald-100 shadow-xs space-y-4">
                                            <div className="flex items-center justify-between pb-3 border-b border-stone-100 flex-wrap gap-2">
                                                <div className="font-bold text-sm text-stone-800 flex items-center gap-2">
                                                    <span>👨‍👩‍👧</span> מספרי טלפון של ההורים (לסיכום השבועי במוצ"ש)
                                                </div>
                                                <button 
                                                    onClick={() => handleSendParentWeeklyReportWhatsApp(false)}
                                                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 flex items-center gap-1.5 shadow-sm">
                                                    <span>📊</span> שליחת דוח שבועי להורים עכשיו
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div>
                                                    <label className="text-xs font-bold text-stone-600 block mb-1.5 flex items-center justify-between">
                                                        <span>הורה 1 (למשל אמא)</span>
                                                        {activeUserData.parentPhoneNumber && (
                                                            <button 
                                                                onClick={() => handleSendWhatsAppTest('parent1')}
                                                                className="text-emerald-700 hover:underline text-[11px] font-bold">
                                                                💬 בדיקת מספר
                                                            </button>
                                                        )}
                                                    </label>
                                                    <input 
                                                        type="tel"
                                                        dir="ltr"
                                                        placeholder="לדוגמה: 052-1234567"
                                                        value={activeUserData.parentPhoneNumber || ''}
                                                        onChange={(e) => updateUserData({ parentPhoneNumber: e.target.value })}
                                                        className="w-full p-3 bg-stone-50 border border-stone-200 rounded-xl text-sm font-semibold outline-none focus:border-emerald-500 focus:bg-white transition-all text-right"
                                                    />
                                                </div>

                                                <div>
                                                    <label className="text-xs font-bold text-stone-600 block mb-1.5 flex items-center justify-between">
                                                        <span>הורה 2 (למשל אבא - אופציונלי)</span>
                                                        {activeUserData.parentPhoneNumber2 && (
                                                            <button 
                                                                onClick={() => handleSendWhatsAppTest('parent2')}
                                                                className="text-emerald-700 hover:underline text-[11px] font-bold">
                                                                💬 בדיקת מספר
                                                            </button>
                                                        )}
                                                    </label>
                                                    <input 
                                                        type="tel"
                                                        dir="ltr"
                                                        placeholder="לדוגמה: 054-7654321"
                                                        value={activeUserData.parentPhoneNumber2 || ''}
                                                        onChange={(e) => updateUserData({ parentPhoneNumber2: e.target.value })}
                                                        className="w-full p-3 bg-stone-50 border border-stone-200 rounded-xl text-sm font-semibold outline-none focus:border-emerald-500 focus:bg-white transition-all text-right"
                                                    />
                                                </div>
                                            </div>

                                            <label className="flex items-center gap-3 p-3 bg-emerald-50/60 rounded-xl cursor-pointer hover:bg-emerald-50 transition-colors border border-emerald-100">
                                                <input 
                                                    type="checkbox"
                                                    checked={activeUserData.autoSendParentReport !== false}
                                                    onChange={(e) => updateUserData({ autoSendParentReport: e.target.checked })}
                                                    className="w-4 h-4 text-emerald-600 rounded accent-emerald-600"
                                                />
                                                <div className="text-xs text-stone-700">
                                                    <span className="font-bold block">שליחה אוטומטית של דוח שבועי בכל מוצאי שבת 🗓️</span>
                                                    <span className="text-stone-500">המערכת תסכם אוטומטית את כל המשימות, שעות הלמידה וההתמדה ותשלח לשני ההורים בימי שבת בערב.</span>
                                                </div>
                                            </label>
                                        </div>
                                    </div>

                                    {/* Gateway Config Accordion */}
                                    <details className="group bg-white/85 backdrop-blur-sm rounded-2xl border border-emerald-200/80 p-4 transition-all">
                                        <summary className="font-bold text-xs text-stone-700 cursor-pointer flex items-center justify-between list-none select-none">
                                            <span className="flex items-center gap-2">
                                                <span>🤖</span>
                                                <span>חיבור Gateway לשליחה אוטומטית מלאה ברקע (Green-API / Instance)</span>
                                                <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-md font-bold">
                                                    {activeUserData.whatsappGateway?.instanceId ? '✓ מחובר' : 'הגדרות חיבור'}
                                                </span>
                                            </span>
                                            <span className="transition-transform group-open:rotate-180 text-stone-400">▼</span>
                                        </summary>
                                        <div className="mt-4 pt-3 border-t border-emerald-100 text-xs text-stone-600 space-y-3">
                                            <p className="leading-relaxed">
                                                <b>איך זה עובד?</b> במצב רגיל, המערכת פותחת חלון וואטסאפ מוכן עם הטקסט והנמען. בזכות חיבור ה-Green-API שלך, המערכת שולחת את התזכורות ודוחות ההורים ישירות ועצמאית ברקע מבלי לפתוח חלון ומבלי שתצטרכי לאשר ידנית!
                                            </p>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                                                <div>
                                                    <label className="font-bold text-stone-700 block mb-1 text-[11px]">Id Instance</label>
                                                    <input 
                                                        type="text"
                                                        placeholder="למשל: 110182..."
                                                        value={activeUserData.whatsappGateway?.instanceId || ''}
                                                        onChange={(e) => updateUserData(prev => ({
                                                            ...prev,
                                                            whatsappGateway: {
                                                                ...(prev.whatsappGateway || {}),
                                                                instanceId: e.target.value
                                                            }
                                                        }))}
                                                        className="w-full p-2.5 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono outline-none focus:border-emerald-500 focus:bg-white"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="font-bold text-stone-700 block mb-1 text-[11px]">Api Token Instance</label>
                                                    <input 
                                                        type="password"
                                                        placeholder="טוקן סודי של ה-Instance"
                                                        value={activeUserData.whatsappGateway?.apiToken || ''}
                                                        onChange={(e) => updateUserData(prev => ({
                                                            ...prev,
                                                            whatsappGateway: {
                                                                ...(prev.whatsappGateway || {}),
                                                                apiToken: e.target.value
                                                            }
                                                        }))}
                                                        className="w-full p-2.5 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono outline-none focus:border-emerald-500 focus:bg-white"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </details>
                                </div>

                                <div className="bg-white p-6 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                    <div className="flex flex-col sm:flex-row justify-between sm:items-end mb-6 pb-4 border-b border-stone-100 gap-4">
                                        <div>
                                            <h2 className="text-xl font-bold text-stone-800 tracking-tight">מקצועות וכללי הגשה</h2>
                                            <p className="text-sm text-stone-500 mt-1">הגדירי אילו מקצועות את לומדת ומתי מגישים בהם שיעורים.</p>
                                        </div>
                                        <button onClick={() => { setEditingSubject(null); setTempRules([]); toggleModal('subject', true); }} className="bg-purple-100 text-purple-700 px-4 py-3 rounded-xl text-sm font-bold shadow-sm hover:bg-purple-200 transition-colors flex items-center gap-2 active:scale-95">
                                            <IconPlus className="w-4 h-4"/> הוספת מקצוע
                                        </button>
                                    </div>
                                    
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        {activeUserData.subjects.map(sub => {
                                            const completedCount = activeUserData.tasks.filter(t => t.subjectId === sub.id && t.completed && !t.isLessonLog && !t.givenUp && !t.isExamPrep).length;
                                            return (
                                            <div key={sub.id} className="bg-stone-50 p-4 rounded-2xl border border-stone-200 flex flex-col justify-between hover:border-purple-200 transition-colors relative overflow-hidden">
                                                <div className="flex justify-between items-start mb-3 relative z-10">
                                                    <div className="font-bold flex items-center gap-2 text-base text-stone-800">
                                                        <span className="w-4 h-4 rounded-full shadow-sm" style={{backgroundColor: sub.color}}></span>
                                                        {sub.emoji} {sub.name}
                                                    </div>
                                                    <div className="flex gap-1.5">
                                                        <button onClick={() => { setEditingSubject(sub); setTempRules(sub.rules || []); toggleModal('subject', true); }} className="text-stone-500 text-xs font-bold bg-white border border-stone-200 px-3 py-2 rounded-lg hover:bg-stone-100 transition-colors active:scale-95">עריכה</button>
                                                        <button onClick={() => handleDeleteSubject(sub.id)} className="text-rose-500 text-xs font-bold bg-white border border-rose-100 px-3 py-2 rounded-lg hover:bg-rose-50 transition-colors active:scale-95"><IconTrash className="w-3.5 h-3.5"/></button>
                                                    </div>
                                                </div>
                                                
                                                <div className="flex items-center justify-between mt-1 mb-3 relative z-10">
                                                    <span className="text-xs font-bold text-stone-500 bg-white px-2 py-1 rounded-lg border border-stone-200 shadow-sm flex items-center gap-1.5">
                                                        <IconCheck className="w-3.5 h-3.5 text-emerald-500" />
                                                        {completedCount} הגשות בוצעו
                                                    </span>
                                                </div>


                                                <div className="bg-white rounded-xl p-3 text-xs text-stone-600 space-y-1.5 border border-stone-100 relative z-10">
                                                    <div className="font-bold text-stone-800 mb-1">כללי הגשה אוטומטיים:</div>
                                                    {sub.rules && sub.rules.length > 0 ? sub.rules.map((r, i) => (
                                                        <div key={i} className="flex items-center gap-1.5">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-purple-300"></div>
                                                            מיום {DAYS_HE[r.assignDay]} עד יום {DAYS_HE[r.dueDay]} ב-{r.dueTime}
                                                        </div>
                                                    )) : <div className="italic text-stone-400">אין כללים מוגדרים.</div>}
                                                </div>
                                            </div>
                                        )})}
                                        {activeUserData.subjects.length === 0 && <div className="text-sm text-stone-500 font-medium col-span-full py-8 bg-stone-50 rounded-2xl border border-dashed border-stone-300 text-center">עדיין לא הוגדרו מקצועות לימוד.</div>}
                                    </div>
                                </div>


                                <div className="bg-white p-6 md:p-8 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                    <div className="mb-6 pb-4 border-b border-stone-100">
                                        <h2 className="text-xl font-bold text-stone-800 tracking-tight">לו"ז שבועי קבוע (שעות בי"ס ועוגנים)</h2>
                                        <p className="text-sm text-stone-500 mt-1">במקום לראות את כל השבוע מול העיניים, בחרי יום כדי להגדיר אותו.</p>
                                    </div>
                                    
                                    <div className="flex flex-wrap gap-2 mb-6">
                                        {DAYS_HE.map((day, idx) => (
                                            <button 
                                                key={idx} 
                                                onClick={() => setSelectedSettingsDay(idx)}
                                                className={`px-4 py-2.5 rounded-xl text-sm font-bold transition-all border active:scale-95 ${selectedSettingsDay === idx ? 'bg-purple-100 border-purple-300 text-purple-800 shadow-sm' : 'bg-stone-50 border-stone-200 text-stone-500 hover:bg-stone-100'}`}
                                            >
                                                {day}
                                                {activeUserData.scheduleSettings[idx].schoolEndTime && <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full inline-block mr-2"></div>}
                                            </button>
                                        ))}
                                    </div>


                                    <div className="bg-stone-50 p-6 rounded-2xl border border-stone-200 animate-[fadeIn_0.2s_ease-out]">
                                        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 mb-6 border-b border-stone-200/60 pb-4">
                                            <h3 className="font-bold text-lg text-stone-800">הגדרות ליום {DAYS_HE[selectedSettingsDay]}</h3>
                                            <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-xl border border-stone-200 shadow-sm">
                                                <label className="text-sm font-bold text-stone-600">שעת סיום בי"ס:</label>
                                                <input type="time" value={activeUserData.scheduleSettings[selectedSettingsDay].schoolEndTime} onChange={(e) => handleSchoolTimeChange(selectedSettingsDay, e.target.value)} className="p-1 border-b-2 border-stone-200 text-sm font-bold bg-transparent outline-none w-24 focus:border-purple-400 transition-colors" />
                                            </div>
                                        </div>
                                        
                                        <div className="mb-4">
                                            <div className="flex justify-between items-center mb-3">
                                                <h4 className="text-sm font-bold text-stone-700">עוגנים קבועים ביום זה:</h4>
                                                <button onClick={() => { setActiveDayIndex(selectedSettingsDay); toggleModal('addAnchor', true); }} className="text-xs bg-white hover:bg-purple-50 hover:text-purple-700 hover:border-purple-200 px-3 py-2 rounded-lg font-bold text-stone-500 border border-stone-200 transition-colors flex items-center gap-1.5 shadow-sm active:scale-95">
                                                    <IconPlus className="w-3.5 h-3.5"/> הוספת עוגן
                                                </button>
                                            </div>
                                            <div className="space-y-2">
                                                {activeUserData.scheduleSettings[selectedSettingsDay].anchors.length === 0 ? <div className="text-sm text-stone-400 font-medium py-4 text-center bg-white rounded-xl border border-dashed border-stone-200">אין התחייבויות קבועות ביום זה.</div> : (
                                                    activeUserData.scheduleSettings[selectedSettingsDay].anchors.map(a => (
                                                        <div key={a.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center bg-white border border-stone-200 px-4 py-3 rounded-xl shadow-sm gap-2">
                                                            <span className="font-bold text-stone-700">{a.title}</span>
                                                            <div className="flex items-center gap-4 justify-between w-full sm:w-auto">
                                                                <span className="text-stone-600 font-bold bg-stone-50 border border-stone-100 px-3 py-1 rounded-lg text-sm" dir="ltr">מ-{a.start} עד {a.end}</span>
                                                                <button onClick={() => handleDeleteAnchor(selectedSettingsDay, a.id)} className="text-stone-400 hover:text-rose-500 transition-colors p-2 bg-stone-50 rounded-lg active:scale-95"><IconTrash className="w-4 h-4"/></button>
                                                            </div>
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}


                        {}
                        {activeTab === 'schedule' && (
                            <div className="space-y-6 animate-[fadeIn_0.3s_ease-out]">
                                <div className="bg-white p-6 md:p-8 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                    <div className="mb-6 pb-4 border-b border-stone-100">
                                        <h2 className="text-xl font-bold text-stone-800 tracking-tight">תכנון שבועי וזמן פנוי</h2>
                                        <p className="text-sm text-stone-500 mt-1">המערכת משקללת את העוגנים והלימודים שקבעת ומציעה "חלונות למידה" אידיאליים.</p>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {activeUserData.scheduleSettings.map((dayPlan, idx) => {
                                            const isFreeDay = !dayPlan.schoolEndTime;
                                            const windows = isFreeDay && dayPlan.anchors.length === 0 ? [] : calculateSmartWindows(dayPlan.schoolEndTime || '08:30', dayPlan.anchors);
                                            
                                            return (
                                                <div key={idx} className="bg-stone-50 rounded-3xl p-5 border border-stone-200 flex flex-col h-full hover:border-purple-200 transition-colors">
                                                    <div className="flex items-center justify-between pb-3 border-b border-stone-200/60 mb-4">
                                                        <h3 className="font-bold text-base text-stone-800">יום {DAYS_HE[idx]}</h3>
                                                        <span className={`text-xs px-2.5 py-1 rounded-lg font-bold ${!isFreeDay ? 'bg-white border border-stone-200 text-stone-600 shadow-sm' : 'bg-emerald-100 text-emerald-800'}`}>
                                                            {!isFreeDay ? `סיום ב-${dayPlan.schoolEndTime}` : 'יום חופשי'}
                                                        </span>
                                                    </div>
                                                    
                                                    <div className="flex-1 space-y-4 flex flex-col">
                                                        {dayPlan.anchors.length > 0 && (
                                                            <div className="space-y-2 flex-1">
                                                                {dayPlan.anchors.map(a => (
                                                                    <div key={a.id} className="bg-white border border-stone-200 px-3 py-2 rounded-xl text-xs flex justify-between items-center shadow-sm">
                                                                        <span className="font-bold text-stone-700">{a.title}</span>
                                                                        <span className="text-stone-500 font-medium bg-stone-50 px-1.5 py-0.5 rounded" dir="rtl">מ-{a.start} עד {a.end}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                        
                                                        <div className="mt-auto pt-4">
                                                            {isFreeDay && dayPlan.anchors.length === 0 ? (
                                                                <div className="text-xs text-emerald-700 bg-emerald-50 p-3 rounded-2xl border border-emerald-100 font-bold flex items-center gap-2 text-center justify-center">
                                                                    <span>🎉</span> אין עוגנים. יום פנוי ללמידה!
                                                                </div>
                                                            ) : windows && windows.length > 0 ? (
                                                                <div className="bg-purple-50/80 border border-purple-100 p-3 rounded-2xl">
                                                                    <div className="text-xs font-bold text-purple-800 flex items-center gap-1.5 mb-2.5">
                                                                        <IconSparkle className="w-4 h-4 text-purple-500" /> המלצה לחלונות למידה:
                                                                    </div>
                                                                    <div className="space-y-2">
                                                                        {windows.map((w, i) => (
                                                                            <div key={i} className="flex justify-between items-center text-xs bg-white/60 p-2 rounded-xl">
                                                                                <span className="font-bold text-purple-700 bg-white px-2 py-1 rounded-lg shadow-sm border border-purple-100/50" dir="rtl">מ-{w.start} עד {w.end}</span>
                                                                                <span className="text-[10px] text-purple-600/80 font-medium">{w.reason}</span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            ) : !isFreeDay ? (
                                                                <div className="text-xs text-rose-600 bg-rose-50 p-3 rounded-2xl border border-rose-100 font-bold flex items-center gap-2 justify-center">
                                                                    <span>⚠️</span> יום צפוף. אין חלון רציף של 45 דק'.
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>
                        )}


                        {}
                        {activeTab === 'exam_prep' && (() => {
                            const hardExercisesList = activeUserData.tasks.filter(t => t.completed && t.hardExercises && t.hardExercises.trim() !== '');
                            const subjectsWithArchive = [...new Set(hardExercisesList.map(t => t.subjectId))].map(id => activeUserData.subjects.find(s => s.id === id)).filter(Boolean);
                            
                            const filteredArchive = archiveFilter === 'all' 
                                ? hardExercisesList 
                                : hardExercisesList.filter(t => t.subjectId === archiveFilter);


                            return (
                            <div className="space-y-6 max-w-4xl mx-auto animate-[fadeIn_0.3s_ease-out]">
                                
                                <div className="bg-white p-6 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] relative overflow-hidden group">
                                    <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-transform group-hover:scale-110"></div>
                                    <div className="flex flex-col md:flex-row justify-between md:items-end gap-6 relative z-10">
                                        <div>
                                            <h2 className="text-2xl font-bold text-stone-800 tracking-tight flex items-center gap-2">
                                                <span>🗓️</span> מחולל למידה אוטומטי
                                            </h2>
                                            <p className="text-sm text-stone-500 mt-2 max-w-xl leading-relaxed">
                                                הזיני מבחן קרוב. המערכת תסרוק את הלו"ז שלך ותפזר עבורך זמני למידה בחלונות הפנויים בכל הימים שנותרו עד המבחן.
                                            </p>
                                        </div>
                                        <div className="flex flex-col sm:flex-row gap-3 shrink-0">
                                            <button onClick={() => toggleModal('quickExam', true)} className="bg-white text-indigo-600 px-6 py-4 rounded-2xl text-sm font-bold shadow-sm border border-indigo-100 hover:bg-indigo-50 transition-all flex items-center justify-center gap-2 active:scale-95">
                                                <IconPlus className="w-4 h-4"/> הוספה מהירה (ללא לו"ז)
                                            </button>
                                            <button onClick={() => toggleModal('examPlanner', true)} className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white px-6 py-4 rounded-2xl text-sm font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 active:scale-95">
                                                <IconSparkle className="w-4 h-4"/> תכנון למידה חכם
                                            </button>
                                        </div>
                                    </div>


                                    {(activeUserData.exams || []).length > 0 && (
                                        <div className="mt-6 pt-6 border-t border-stone-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 relative z-10">
                                            {(activeUserData.exams || []).sort((a,b) => new Date(a.date) - new Date(b.date)).map(exam => {
                                                const sub = activeUserData.subjects.find(s=>s.id === exam.subjectId);
                                                
                                                const examDateObj = new Date(exam.date);
                                                examDateObj.setHours(0,0,0,0);
                                                const todayObj = new Date();
                                                todayObj.setHours(0,0,0,0);
                                                const isPassed = examDateObj <= todayObj;
                                                
                                                    const examCountdown = getExamCountdown(exam.date);
                                                    return (
                                                    <div key={exam.id} className={`p-5 rounded-3xl border transition-all ${isPassed ? 'bg-stone-50 border-stone-200 opacity-90' : 'bg-white border-indigo-100 shadow-sm hover:shadow-md'}`}>
                                                        <div className="flex justify-between items-start mb-2 gap-2 flex-wrap">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <div className="text-xs font-bold text-stone-500" dir="ltr">{new Date(exam.date).toLocaleDateString('he-IL')}</div>
                                                                {examCountdown && (
                                                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${examCountdown.badgeClass}`}>
                                                                        {examCountdown.text}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-1.5">
                                                                {exam.cancellations > 0 && !isPassed && <div className="text-[10px] font-bold text-rose-600 bg-rose-100 px-1.5 rounded">ביטולים: {exam.cancellations}/3</div>}
                                                                {exam.grade && <div className="text-xs font-black bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded shadow-sm">{exam.grade} ציון</div>}
                                                            </div>
                                                        </div>
                                                        <div className={`font-bold text-lg leading-tight ${isPassed ? 'text-stone-600' : 'text-stone-800'}`}>{exam.examName || 'מבחן'} ב{sub?.name || 'כללי'}</div>
                                                        <div className="text-xs text-stone-500 mt-2 bg-stone-50 inline-block px-2 py-1 rounded-lg border border-stone-200">
                                                            תוכננו {exam.sessionsCount || 0} מפגשים ({exam.targetHours || 0} שעות)
                                                        </div>


                                                        <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-stone-100">
                                                            {!isPassed && (
                                                                <button onClick={() => handleAddExamToCalendar(exam)} className="w-full bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-sm font-bold py-2.5 rounded-xl transition-colors active:scale-95 flex items-center justify-center gap-2">
                                                                    📅 הוספה ליומן 
                                                                </button>
                                                            )}
                                                            {!isPassed && !exam.grade && (
                                                                <button onClick={() => {
                                                                    setExamPlannerData({
                                                                        step: 1,
                                                                        existingExamId: exam.id,
                                                                        subjectId: exam.subjectId,
                                                                        examName: exam.examName || '',
                                                                        date: exam.date,
                                                                        hours: 5,
                                                                        targetSessions: 3,
                                                                        sessions: [],
                                                                        remainingMinutes: 0
                                                                    });
                                                                    toggleModal('examPlanner', true);
                                                                }} className="w-full bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-sm font-bold py-2.5 rounded-xl transition-colors active:scale-95">
                                                                    תכנון למידה
                                                                </button>
                                                            )}
                                                            <button 
                                                                onClick={() => handleGenerateExam(exam.subjectId)} 
                                                                className="w-full bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-xs font-bold py-2.5 rounded-xl transition-colors active:scale-95 flex items-center justify-center gap-1.5 shadow-xs"
                                                                title="הפקת חוברת הכנה מקיפה למבחן זה">
                                                                <span>📄</span> חוברת הכנה A4 / PDF למבחן
                                                            </button>
                                                            {!exam.grade && (
                                                                <button onClick={() => { setActiveExamForGrade(exam); toggleModal('examGrade', true); }} className="w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-sm font-bold py-2.5 rounded-xl transition-colors active:scale-95">
                                                                    הזנת ציון למבחן
                                                                </button>
                                                            )}
                                                            <button 
                                                                onClick={() => handleDeleteExam(exam.id)} 
                                                                className="w-full bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold py-2 rounded-xl transition-colors active:scale-95 flex items-center justify-center gap-1.5"
                                                                title="מחיקת מבחן שבוטל">
                                                                <IconTrash className="w-3.5 h-3.5" /> מחק מבחן
                                                            </button>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>


                                <div className="bg-gradient-to-br from-purple-50 via-indigo-50 to-pink-50 p-6 md:p-8 rounded-3xl border border-purple-100 shadow-sm relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-64 h-64 bg-white/40 rounded-full blur-3xl -ml-20 -mt-20 pointer-events-none"></div>
                                    <h2 className="text-2xl font-bold mb-2 text-stone-800 flex items-center gap-3 relative z-10">
                                        <span className="text-3xl">📄</span> הפקת חוברת הכנה מקיפה למבחן (A4 / PDF)
                                    </h2>
                                    <p className="text-sm text-stone-600 mb-5 font-medium max-w-2xl relative z-10 leading-relaxed">
                                        בחרי מקצוע, והמערכת תפיק חוברת הכנה מרוכזת להדפסה A4 הכוללת את כל הנושאים שנלמדו בכיתה, רשימת שיעורי הבית וההבנה, תרגילים מאתגרים, היסטוריית מבחנים קודמים, וצ'ק-ליסט אישי.
                                    </p>
                                    <div className="flex flex-col sm:flex-row gap-3 relative z-10 bg-white/80 p-2.5 rounded-2xl backdrop-blur-sm border border-white/60 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)]">
                                        <select id="examSub" className="p-3.5 border-none bg-transparent rounded-xl flex-1 text-sm text-stone-800 font-bold outline-none cursor-pointer focus:ring-2 focus:ring-purple-200 transition-all">
                                            <option value="">-- בחרי מקצוע להפקת חוברת הכנה --</option>
                                            {(() => {
                                                const subjectsList = [...(activeUserData.subjects || [])];
                                                (activeUserData.tasks || []).forEach(t => {
                                                    if (t.subjectId && !subjectsList.some(s => s.id === t.subjectId || s.name === t.subjectId)) {
                                                        subjectsList.push({ id: t.subjectId, name: t.subjectName || t.subjectId, emoji: '📖' });
                                                    }
                                                });
                                                return subjectsList.map(s => <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>);
                                            })()}
                                        </select>
                                        <button onClick={() => {
                                            const val = document.getElementById('examSub').value;
                                            if (!val) {
                                                showToast('יש לבחור מקצוע מהרשימה', 'warning');
                                                return;
                                            }
                                            handleGenerateExam(val);
                                        }} className="bg-stone-800 hover:bg-stone-900 text-white px-8 py-3.5 rounded-xl text-sm font-bold shadow-md whitespace-nowrap transition-all hover:shadow-lg active:scale-95 flex items-center justify-center gap-2">
                                            <span>📄</span> הפקת חוברת PDF
                                        </button>
                                    </div>
                                </div>


                                <div className="bg-white p-6 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                    <div className="flex flex-col md:flex-row justify-between md:items-end mb-6 gap-4">
                                        <div>
                                            <h3 className="text-xl font-bold text-stone-800 tracking-tight">בנק תרגילים מאתגרים (ארכיון)</h3>
                                            <p className="text-sm text-stone-500 mt-1">כל מה שסימנת שקשה לך, ממוין לפי מקצוע.</p>
                                        </div>
                                    </div>


                                    {subjectsWithArchive.length > 0 && (
                                        <div className="flex flex-wrap gap-2 mb-4 pb-4 border-b border-stone-100">
                                            <button 
                                                onClick={() => setArchiveFilter('all')}
                                                className={`px-4 py-2.5 rounded-full text-sm font-bold transition-all border active:scale-95 ${archiveFilter === 'all' ? 'bg-stone-800 text-white border-stone-800 shadow-sm' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                                            >
                                                הכל ביחד
                                            </button>
                                            {subjectsWithArchive.map(sub => (
                                                <button 
                                                    key={sub.id}
                                                    onClick={() => setArchiveFilter(sub.id)}
                                                    className={`px-4 py-2.5 rounded-full text-sm font-bold transition-all border flex items-center gap-1.5 active:scale-95 ${archiveFilter === sub.id ? 'bg-purple-100 text-purple-800 border-purple-200 shadow-sm' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}
                                                >
                                                    <span>{sub.emoji}</span> {sub.name}
                                                </button>
                                            ))}
                                        </div>
                                    )}


                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {filteredArchive.map(t => {
                                            const sub = activeUserData.subjects.find(s=>s.id === t.subjectId);
                                            return (
                                                <div key={t.id} className="border border-stone-200 p-5 rounded-3xl bg-stone-50 relative overflow-hidden group hover:border-purple-200 transition-colors shadow-sm animate-[fadeIn_0.2s_ease-out]">
                                                    <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-purple-400 to-pink-400"></div>
                                                    <div className="text-xs font-bold text-stone-500 mb-3 flex flex-wrap items-center gap-2 pr-2">
                                                        <span className="bg-white px-2 py-1 rounded-lg border border-stone-200 shadow-sm" dir="ltr">{new Date(t.completedAt).toLocaleDateString('he-IL')}</span>
                                                        <span className="px-2 py-1 rounded-lg text-white shadow-sm" style={{backgroundColor: sub?.color || '#a8a29e'}}>{sub?.emoji} {sub?.name || 'כללי'}</span>
                                                        <span className="bg-purple-50 text-purple-700 border border-purple-100 px-2 py-1 rounded-lg">{t.lessonTopic}</span>
                                                    </div>
                                                    <div className="font-bold text-stone-800 text-base mb-3 pr-2">{t.title}</div>
                                                    <div className="text-stone-700 text-sm bg-white p-4 rounded-2xl border border-stone-200 mr-2 font-medium shadow-inner">
                                                        <span className="text-rose-600 font-bold block mb-1">📌 שאלות שסומנו לחזרה:</span> 
                                                        {t.hardExercises}
                                                    </div>
                                                </div>
                                            )
                                        })}
                                        {hardExercisesList.length === 0 && <div className="col-span-full text-sm font-medium text-stone-400 text-center py-12 bg-stone-50 rounded-3xl border border-dashed border-stone-200">לא סומנו תרגילים קשים עדיין. מעולה!</div>}
                                    </div>
                                </div>
                            </div>
                            )
                        })()}


                        {}
                        {activeTab === 'analytics' && (() => {
                            const allTasks = activeUserData.tasks || [];
                            const rawCompletedTasks = allTasks.filter(t => t.completed && !t.givenUp && !t.isLessonLog);
                            const rawExams = activeUserData.exams || [];

                            const formatMonthLabel = (ymStr) => {
                                try {
                                    const [year, month] = ymStr.split('-').map(Number);
                                    const d = new Date(year, month - 1, 1);
                                    return d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
                                } catch(e) {
                                    return ymStr;
                                }
                            };

                            const getTaskDate = (t) => {
                                if (t.completedAt) return new Date(t.completedAt);
                                if (t.dueDate) return new Date(t.dueDate);
                                if (t.createdAt) return new Date(t.createdAt);
                                return null;
                            };

                            // בניית רשימת חודשים קיימים מתוך המשימות והמבחנים
                            const availableMonths = new Set();
                            const now = new Date();
                            const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                            availableMonths.add(currentYM);

                            rawCompletedTasks.forEach(t => {
                                const d = getTaskDate(t);
                                if (d && !isNaN(d.getTime())) {
                                    availableMonths.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
                                }
                            });
                            rawExams.forEach(ex => {
                                if (ex.date) {
                                    const d = new Date(ex.date);
                                    if (!isNaN(d.getTime())) {
                                        availableMonths.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
                                    }
                                }
                            });
                            const sortedMonths = Array.from(availableMonths).sort().reverse();

                            const isTaskInFilter = (t) => {
                                if (analyticsTimeFilter === 'all') return true;
                                const taskDate = getTaskDate(t);
                                if (!taskDate || isNaN(taskDate.getTime())) return false;
                                if (analyticsTimeFilter === 'last30') {
                                    const thirtyDaysAgo = new Date();
                                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                                    return taskDate >= thirtyDaysAgo;
                                }
                                const ym = `${taskDate.getFullYear()}-${String(taskDate.getMonth() + 1).padStart(2, '0')}`;
                                return ym === analyticsTimeFilter;
                            };

                            const isExamInFilter = (ex) => {
                                if (analyticsTimeFilter === 'all') return true;
                                if (!ex.date) return false;
                                const exDate = new Date(ex.date);
                                if (!exDate || isNaN(exDate.getTime())) return false;
                                if (analyticsTimeFilter === 'last30') {
                                    const thirtyDaysAgo = new Date();
                                    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                                    return exDate >= thirtyDaysAgo;
                                }
                                const ym = `${exDate.getFullYear()}-${String(exDate.getMonth() + 1).padStart(2, '0')}`;
                                return ym === analyticsTimeFilter;
                            };

                            const completedTasks = rawCompletedTasks.filter(isTaskInFilter);
                            const exams = rawExams.filter(isExamInFilter);

                            const onTimeCount = completedTasks.filter(t => {
                                if (!t.dueDate || !t.dueTime || !t.completedAt) return true;
                                return new Date(t.completedAt) <= new Date(`${t.dueDate}T${t.dueTime}`);
                            }).length;
                            const onTimePct = completedTasks.length > 0 ? Math.round((onTimeCount / completedTasks.length) * 100) : 100;
                            
                            const hourBuckets = {
                                morning: { label: 'בוקר (06:00-12:00)', count: 0, icon: '🌅' },
                                afternoon: { label: 'צהריים (12:00-17:00)', count: 0, icon: '☀️' },
                                evening: { label: 'ערב (17:00-21:00)', count: 0, icon: '🌆' },
                                night: { label: 'לילה (21:00-02:00)', count: 0, icon: '🌙' },
                                lateNight: { label: 'לפנות בוקר (02:00-06:00)', count: 0, icon: '🦉' }
                            };
                            
                            const hourlyCounts = Array(24).fill(0);
                            let maxHourCount = 0;
                            let peakHour = null;

                            completedTasks.forEach(t => {
                                if (t.completedAt) {
                                    const h = new Date(t.completedAt).getHours();
                                    hourlyCounts[h]++;
                                    if (h >= 6 && h < 12) hourBuckets.morning.count++;
                                    else if (h >= 12 && h < 17) hourBuckets.afternoon.count++;
                                    else if (h >= 17 && h < 21) hourBuckets.evening.count++;
                                    else if (h >= 21 || h < 2) hourBuckets.night.count++;
                                    else hourBuckets.lateNight.count++;
                                }
                            });

                            for (let h = 0; h < 24; h++) {
                                if (hourlyCounts[h] > maxHourCount) {
                                    maxHourCount = hourlyCounts[h];
                                    peakHour = h;
                                }
                            }

                            const subjectStats = (activeUserData.subjects || []).map(sub => {
                                const subTasks = completedTasks.filter(t => !t.isLessonLog && t.subjectId === sub.id && t.understandingRating);
                                const ratings = subTasks.map(t => t.understandingRating);
                                const avg = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
                                return {
                                    ...sub,
                                    completedCount: subTasks.length,
                                    avgRating: avg ? parseFloat(avg) : null
                                };
                            }).filter(s => s.completedCount > 0).sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));

                            const allRatings = completedTasks.filter(t => !t.isLessonLog && t.understandingRating).map(t => t.understandingRating);
                            const overallAvgRating = allRatings.length > 0 ? (allRatings.reduce((a, b) => a + b, 0) / allRatings.length).toFixed(1) : null;

                            const gradedExams = exams.filter(e => e.grade);
                            const examAvg = gradedExams.length > 0 ? (gradedExams.reduce((sum, e) => sum + Number(e.grade), 0) / gradedExams.length).toFixed(1) : null;

                            const currentFilterLabel = analyticsTimeFilter === 'all' 
                                ? 'כל הזמנים 🌟' 
                                : analyticsTimeFilter === 'last30' 
                                    ? '30 ימים אחרונים ⏱️' 
                                    : `חודש ${formatMonthLabel(analyticsTimeFilter)} 📅`;

                            return (
                                <div className="space-y-6 max-w-5xl mx-auto animate-[fadeIn_0.3s_ease-out]">
                                    <div className="bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-800 p-6 md:p-8 rounded-3xl text-white shadow-xl relative overflow-hidden">
                                        <div className="absolute top-0 left-0 w-80 h-80 bg-white/10 rounded-full blur-3xl -ml-20 -mt-20 pointer-events-none"></div>
                                        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                                            <div>
                                                <div className="text-purple-200 text-xs font-bold uppercase tracking-wider mb-1">לוח בקרה וניתוח למידה</div>
                                                <h2 className="text-2xl md:text-3xl font-extrabold flex items-center gap-2">
                                                    <span>📊</span> סיכום סטטיסטי ותובנות למידה
                                                </h2>
                                                <p className="text-purple-100 text-sm mt-1 max-w-xl">
                                                    תמונת מצב מעמיקה על שעות ההגשה, רמות ההבנה בנושאים השונים וציוני המבחנים שלך לקראת הבגרות.
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-3 flex-wrap">
                                                <button 
                                                    onClick={handlePrintAnalyticsReport} 
                                                    className="bg-white/20 hover:bg-white text-white hover:text-purple-900 px-4 py-2.5 rounded-2xl text-xs md:text-sm font-bold border border-white/30 transition-all flex items-center gap-2 shadow-sm active:scale-95">
                                                    <span>📄</span> הדפסת דוח A4 / PDF
                                                </button>
                                                {examAvg && (
                                                    <div className="bg-white/15 backdrop-blur-md px-5 py-2.5 rounded-2xl border border-white/20 text-center shrink-0">
                                                        <div className="text-xs text-purple-200 font-bold">ממוצע מבחנים</div>
                                                        <div className="text-2xl font-black">{examAvg} 🎓</div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* בר סינון תקופת זמן מתקדם */}
                                    <div className="bg-white p-3.5 md:p-4 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-xs font-bold text-stone-500 ml-1">סינון לפי תקופה:</span>
                                            <button 
                                                onClick={() => setAnalyticsTimeFilter('all')}
                                                className={`px-3.5 py-1.5 rounded-2xl text-xs md:text-sm font-bold transition-all active:scale-95 ${
                                                    analyticsTimeFilter === 'all' 
                                                        ? 'bg-purple-600 text-white shadow-sm shadow-purple-200' 
                                                        : 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                                                }`}>
                                                הכל (כל הזמנים) 🌟
                                            </button>
                                            <button 
                                                onClick={() => setAnalyticsTimeFilter('last30')}
                                                className={`px-3.5 py-1.5 rounded-2xl text-xs md:text-sm font-bold transition-all active:scale-95 ${
                                                    analyticsTimeFilter === 'last30' 
                                                        ? 'bg-purple-600 text-white shadow-sm shadow-purple-200' 
                                                        : 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                                                }`}>
                                                חודש אחרון (30 ימים) ⏱️
                                            </button>
                                            <div className="relative inline-flex items-center">
                                                <select 
                                                    value={sortedMonths.includes(analyticsTimeFilter) ? analyticsTimeFilter : ''}
                                                    onChange={e => {
                                                        if (e.target.value) setAnalyticsTimeFilter(e.target.value);
                                                    }}
                                                    className={`px-3 py-1.5 rounded-2xl text-xs md:text-sm font-bold border transition-all cursor-pointer appearance-none pl-7 pr-3 ${
                                                        sortedMonths.includes(analyticsTimeFilter)
                                                            ? 'bg-purple-600 text-white border-purple-600 shadow-sm shadow-purple-200 font-extrabold'
                                                            : 'bg-stone-100 text-stone-700 border-stone-200 hover:bg-stone-200'
                                                    }`}
                                                >
                                                    <option value="" disabled className="bg-white text-stone-700">לפי חודשים 📅</option>
                                                    {sortedMonths.map(ym => (
                                                        <option key={ym} value={ym} className="bg-white text-stone-900 font-semibold">
                                                            {formatMonthLabel(ym)}
                                                        </option>
                                                    ))}
                                                </select>
                                                <span className={`absolute left-2.5 pointer-events-none text-[10px] ${sortedMonths.includes(analyticsTimeFilter) ? 'text-white' : 'text-stone-500'}`}>▼</span>
                                            </div>
                                        </div>

                                        <div className="text-xs font-semibold text-purple-700 bg-purple-50 px-3 py-1.5 rounded-xl border border-purple-100 flex items-center gap-1 self-start sm:self-auto">
                                            <span>מציג נתונים:</span>
                                            <span className="font-extrabold">{currentFilterLabel}</span>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                        <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100">
                                            <div className="text-stone-400 text-xs font-semibold mb-1">סה"כ משימות שהושלמו</div>
                                            <div className="text-2xl md:text-3xl font-black text-stone-800">{completedTasks.length}</div>
                                            <div className="text-[11px] text-emerald-600 font-bold mt-1">מתוכן {onTimeCount} בזמן!</div>
                                        </div>
                                        <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100">
                                            <div className="text-stone-400 text-xs font-semibold mb-1">אחוז הגשה בזמן</div>
                                            <div className="text-2xl md:text-3xl font-black text-purple-600" dir="ltr">{onTimePct}%</div>
                                            <div className="text-[11px] text-stone-500 font-medium mt-1">{onTimePct >= 80 ? 'מצוין! חסינת איחורים ⏱️' : 'שימי לב לדדליינים ⏰'}</div>
                                        </div>
                                        <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100">
                                            <div className="text-stone-400 text-xs font-semibold mb-1">מדד הבנה ממוצע</div>
                                            <div className="text-2xl md:text-3xl font-black text-amber-500 flex items-center gap-1">
                                                {overallAvgRating || '-'}<span className="text-sm">/5</span> ⭐️
                                            </div>
                                            <div className="text-[11px] text-stone-500 font-medium mt-1">לפי דירוג ההבנה שלך</div>
                                        </div>
                                        <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100">
                                            <div className="text-stone-400 text-xs font-semibold mb-1">שעת שיא בהגשות</div>
                                            <div className="text-2xl md:text-3xl font-black text-indigo-600">
                                                {peakHour !== null ? `${String(peakHour).padStart(2, '0')}:00` : '--:--'}
                                            </div>
                                            <div className="text-[11px] text-stone-500 font-medium mt-1">השעה הכי פעילה שלך</div>
                                        </div>
                                    </div>

                                    <div className="bg-white p-6 md:p-8 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-6">
                                            <div>
                                                <h3 className="text-xl font-bold text-stone-800 flex items-center gap-2">
                                                    <span>🕒</span> התפלגות שעות ההגשה שלך
                                                </h3>
                                                <p className="text-xs text-stone-500 mt-0.5">באיזה שעות ביום את מסיימת ומגישה את שיעורי הבית?</p>
                                            </div>
                                            {peakHour !== null && (
                                                <span className="bg-indigo-50 text-indigo-700 border border-indigo-200 px-3 py-1.5 rounded-xl text-xs font-bold">
                                                    ⚡ רוב ההגשות מתבצעות ב-{peakHour < 12 ? 'בוקר' : peakHour < 17 ? 'צהריים' : peakHour < 21 ? 'ערב' : 'לילה'} ({String(peakHour).padStart(2, '0')}:00)
                                                </span>
                                            )}
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                                            {Object.entries(hourBuckets).map(([key, bucket]) => {
                                                const total = completedTasks.length || 1;
                                                const pct = Math.round((bucket.count / total) * 100);
                                                return (
                                                    <div key={key} className="bg-stone-50/80 p-4 rounded-2xl border border-stone-200/60">
                                                        <div className="flex items-center justify-between text-xs font-bold text-stone-600 mb-2">
                                                            <span className="flex items-center gap-1.5">{bucket.icon} {bucket.label}</span>
                                                            <span className="text-stone-800 font-black">{bucket.count} משימות</span>
                                                        </div>
                                                        <div className="w-full bg-stone-200/80 rounded-full h-2.5 overflow-hidden">
                                                            <div className="bg-purple-600 h-full rounded-full transition-all duration-500" style={{ width: `${pct}%` }}></div>
                                                        </div>
                                                        <div className="text-[11px] text-stone-400 font-semibold mt-1.5 text-left" dir="ltr">{pct}%</div>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        <div>
                                            <div className="text-xs font-bold text-stone-500 mb-2">גרף שעות ביממה (00:00 עד 23:00):</div>
                                            <div className="flex items-end gap-1 h-28 bg-stone-50 p-3 rounded-2xl border border-stone-200/50 overflow-x-auto">
                                                {hourlyCounts.map((count, hour) => {
                                                    const heightPct = maxHourCount > 0 ? Math.max(8, (count / maxHourCount) * 100) : 8;
                                                    const isPeak = hour === peakHour && count > 0;
                                                    return (
                                                        <div key={hour} className="flex-1 flex flex-col items-center justify-end h-full min-w-[20px] group relative">
                                                            <div className="text-[9px] font-bold text-stone-500 mb-1 opacity-0 group-hover:opacity-100 transition-opacity">{count}</div>
                                                            <div 
                                                                className={`w-full rounded-t-md transition-all ${isPeak ? 'bg-gradient-to-t from-purple-600 to-pink-500 shadow-sm' : count > 0 ? 'bg-purple-400 hover:bg-purple-500' : 'bg-stone-200/60'}`}
                                                                style={{ height: `${count > 0 ? heightPct : 6}%` }}
                                                                title={`${hour}:00 - ${count} משימות`}
                                                            ></div>
                                                            <span className="text-[8px] text-stone-400 font-bold mt-1">{hour % 3 === 0 ? `${hour}` : ''}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                        <div className="bg-white p-6 md:p-8 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                            <div className="flex justify-between items-center mb-6">
                                                <div>
                                                    <h3 className="text-xl font-bold text-stone-800 flex items-center gap-2">
                                                        <span>⭐️</span> רמות הבנה לפי מקצוע
                                                    </h3>
                                                    <p className="text-xs text-stone-500 mt-0.5">ממוצע הבנה (1 עד 5 כוכבים) שהוזן בסיום המשימות</p>
                                                </div>
                                            </div>

                                            {subjectStats.length > 0 ? (
                                                <div className="space-y-4">
                                                    {subjectStats.map(sub => {
                                                        const rating = sub.avgRating || 0;
                                                        const pct = (rating / 5) * 100;
                                                        const isStrong = rating >= 4.2;
                                                        const isWeak = rating <= 3.0;

                                                        return (
                                                            <div key={sub.id} className="p-4 rounded-2xl border border-stone-100 bg-stone-50/50 hover:bg-white transition-all">
                                                                <div className="flex items-center justify-between mb-2">
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-base">{sub.emoji}</span>
                                                                        <span className="font-bold text-sm text-stone-800">{sub.name}</span>
                                                                        {isStrong && <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold">חזקה! 💪</span>}
                                                                        {isWeak && <span className="text-[10px] bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full font-bold">חיזוק נדרש 🎯</span>}
                                                                    </div>
                                                                    <div className="flex items-center gap-1 text-sm font-black text-stone-800">
                                                                        <span className="text-amber-500">★</span> {rating} <span className="text-xs text-stone-400 font-normal">({sub.completedCount} משימות)</span>
                                                                    </div>
                                                                </div>
                                                                <div className="w-full bg-stone-200/80 rounded-full h-2.5 overflow-hidden">
                                                                    <div 
                                                                        className={`h-full rounded-full transition-all duration-700 ${isStrong ? 'bg-emerald-500' : isWeak ? 'bg-rose-500' : 'bg-purple-500'}`}
                                                                        style={{ width: `${pct}%` }}
                                                                    ></div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <div className="text-center py-10 text-stone-400 text-sm font-medium">
                                                    טרם הושלמו משימות עם דירוג הבנה. סמני משימות כ"סיימתי" ודרגי את ההבנה!
                                                </div>
                                            )}
                                        </div>

                                        <div className="bg-white p-6 md:p-8 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] flex flex-col justify-between">
                                            <div>
                                                <div className="flex justify-between items-center mb-6">
                                                    <div>
                                                        <h3 className="text-xl font-bold text-stone-800 flex items-center gap-2">
                                                            <span>📝</span> ציוני מבחנים ולוח זמנים
                                                        </h3>
                                                        <p className="text-xs text-stone-500 mt-0.5">ספירה לאחור לבחינות וציונים שהושגו</p>
                                                    </div>
                                                    <button onClick={() => toggleModal('quickExam', true)} className="bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors flex items-center gap-1 active:scale-95">
                                                        <IconPlus className="w-3.5 h-3.5" /> מבחן חדש
                                                    </button>
                                                </div>

                                                {exams.length > 0 ? (
                                                    <div className="space-y-3 max-h-96 overflow-y-auto custom-scrollbar pr-1">
                                                        {exams.sort((a, b) => new Date(a.date) - new Date(b.date)).map(ex => {
                                                            const sub = (activeUserData.subjects || []).find(s => s.id === ex.subjectId);
                                                            const examCountdown = getExamCountdown(ex.date);
                                                            return (
                                                                <div key={ex.id} className="p-3.5 bg-stone-50/70 hover:bg-white rounded-2xl border border-stone-100 transition-all flex items-center justify-between gap-3">
                                                                    <div className="flex-1">
                                                                        <div className="flex items-center gap-2 flex-wrap">
                                                                            <span className="font-bold text-sm text-stone-800">{ex.examName || 'מבחן'} ב{sub?.name || 'כללי'}</span>
                                                                            {examCountdown && (
                                                                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${examCountdown.badgeClass}`}>
                                                                                    {examCountdown.text}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                        <div className="text-xs text-stone-400 mt-0.5" dir="ltr">
                                                                            {new Date(ex.date).toLocaleDateString('he-IL')}
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-2 shrink-0">
                                                                        {ex.grade ? (
                                                                            <div className="bg-emerald-100 text-emerald-800 font-black text-sm px-2.5 py-1 rounded-xl shadow-xs">
                                                                                {ex.grade}
                                                                            </div>
                                                                        ) : (
                                                                            <button onClick={() => { setActiveExamForGrade(ex); toggleModal('examGrade', true); }} className="text-xs bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-2.5 py-1.5 rounded-xl font-bold transition-colors">
                                                                                הזנת ציון
                                                                            </button>
                                                                        )}
                                                                        <button 
                                                                            onClick={() => handleDeleteExam(ex.id)}
                                                                            className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors active:scale-95"
                                                                            title="מחיקת מבחן">
                                                                            <IconTrash className="w-4 h-4" />
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    <div className="text-center py-10 text-stone-400 text-sm font-medium">
                                                        אין מבחנים רשומים כרגע. לחצי על "מבחן חדש" כדי להוסיף!
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })()}


                        {}
                        {activeTab === 'social' && (() => {

                            // סינון חברות כפולות והבטחה שרק מי שברשימת החברים הנוכחית מופיע בטבלה
                            const uniqueFriendsMap = new Map();
                            if (activeUserData && activeUserData.friends) {
                                activeUserData.friends.forEach(f => {
                                    if (f && f.username && f.username !== globalState.activeUser) {
                                        // שואבים נתונים חיים רק עבור מי שמוגדרת כחברה כרגע
                                        const liveData = liveFriends[f.username] || {};
                                        uniqueFriendsMap.set(f.username, {
                                            ...f, // הבסיס מהרשימה המקומית (שם וכו')
                                            ...liveData, // נתונים חיים אם ישנם (נקודות, רצף וכו')
                                            username: f.username // וידוא סופי לשם המשתמש כדי למנוע באגים
                                        });
                                    }
                                });
                            }
                            
                            const allUsers = [
                                { ...activeUserData, isMe: true, username: globalState.activeUser },
                                ...Array.from(uniqueFriendsMap.values())
                            ];
                            
                            const topUserPoints = Math.max(...allUsers.map(u => u?.totalPoints || 0), 0);
                            
                            // חיתוך למקומות ראשון, שני ושלישי בלבד (Top 3)
                            const sortedByPoints = [...allUsers].sort((a,b) => (b.totalPoints || 0) - (a.totalPoints || 0)).slice(0, 3);
                            const sortedByStreak = [...allUsers].sort((a,b) => (b.taskStreak || 0) - (a.taskStreak || 0)).slice(0, 3);


                            return (
                            <div className="space-y-6 animate-[fadeIn_0.3s_ease-out]">
                                <div className="flex flex-col md:flex-row justify-between md:items-end gap-4 bg-white p-6 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)]">
                                    <div>
                                        <h2 className="text-2xl font-bold text-stone-800 tracking-tight">החברות שלי והישגים</h2>
                                        <p className="text-sm text-stone-500 mt-1">עקבי אחרי ההתקדמות של החברות, שלחי תזכורות, וראי מי אלופת הרצף!</p>
                                    </div>
                                    <button onClick={() => toggleModal('addFriend', true)} className="bg-gradient-to-r from-purple-500 to-pink-500 text-white px-6 py-4 rounded-2xl text-sm font-bold shadow-md hover:from-purple-600 hover:to-pink-600 transition-all flex items-center justify-center gap-2 active:scale-95">
                                        <IconPlus className="w-4 h-4"/> הוספת חברה
                                    </button>
                                </div>
                                
                                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
                                    <div className="bg-white rounded-3xl p-6 md:p-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-stone-100 relative overflow-hidden">
                                        <div className="absolute top-0 right-0 w-40 h-40 bg-amber-50 rounded-bl-full -mr-16 -mt-16 pointer-events-none"></div>
                                        <h3 className="font-black text-2xl text-stone-800 mb-6 flex items-center gap-3 relative z-10">
                                            <span className="text-3xl drop-shadow-sm">🏆</span> טבלת אלופות (ניקוד)
                                        </h3>
                                        <div className="space-y-4 relative z-10">
                                            {sortedByPoints.map((u, i) => {
                                                const points = u.totalPoints || 0;
                                                const topPoints = Math.max(sortedByPoints[0]?.totalPoints || 1, 1);
                                                const progressPct = Math.max(2, (points / topPoints) * 100);
                                                const gap = topUserPoints - points;
                                                
                                                return (
                                                <div key={u.isMe ? 'me' : u.username} className={`relative flex flex-col p-5 rounded-2xl border transition-all ${u.isMe ? 'bg-purple-50/40 border-purple-200 shadow-sm' : 'bg-stone-50 border-stone-200 hover:border-stone-300'}`}>
                                                    <div className="flex flex-wrap sm:flex-nowrap items-center justify-between mb-4 gap-3">
                                                        <div className="flex items-center gap-4">
                                                            <div className="text-3xl font-black w-10 text-center flex justify-center items-center drop-shadow-sm shrink-0">
                                                                {i===0 ? '🥇' : i===1 ? '🥈' : '🥉'}
                                                            </div>
                                                            <div className="flex items-center gap-3">
                                                                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-100 to-rose-100 flex items-center justify-center text-lg font-black text-purple-700 shadow-inner border-2 border-white shrink-0">
                                                                    {(u.name || 'א').charAt(0)}
                                                                </div>
                                                                <div>
                                                                    <div className={`font-bold text-base md:text-lg flex items-center gap-2 ${u.isMe ? 'text-purple-800' : 'text-stone-800'}`}>
                                                                        {u.name} {u.isMe && <span className="text-[10px] bg-purple-600 text-white px-2 py-0.5 rounded-full font-bold shadow-sm">אני</span>}
                                                                    </div>
                                                                    <div className="text-xs text-stone-400 font-medium mt-0.5" dir="ltr">@{u.isMe ? globalState.activeUser : (u.username || 'user')}</div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="font-black text-xl bg-white px-5 py-2 rounded-xl shadow-sm border border-stone-100 flex items-center gap-1.5 shrink-0" dir="ltr">
                                                            {points} <span className="text-sm text-stone-400 font-bold">נק'</span>
                                                        </div>
                                                    </div>
                                                    <div className="w-full bg-stone-200/80 rounded-full h-3 mb-1.5 relative overflow-hidden shadow-inner">
                                                        <div className={`h-full rounded-full transition-all duration-1000 ease-out ${u.isMe ? 'bg-purple-500' : i === 0 ? 'bg-amber-400' : 'bg-stone-400'}`} style={{ width: `${progressPct}%` }}></div>
                                                    </div>
                                                    {i > 0 && gap > 0 && (
                                                        <div className="text-xs text-stone-500 font-bold mt-1">
                                                            רחוקה ב-<span className="text-stone-800 px-1">{gap}</span> נקודות מהמקום הראשון
                                                        </div>
                                                    )}
                                                </div>
                                            )})}
                                            {sortedByPoints.length === 0 && <div className="text-center py-6 text-stone-400 font-medium">אין משתמשים בטבלה עדיין.</div>}
                                        </div>
                                    </div>


                                    <div className="bg-white rounded-3xl p-6 md:p-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-stone-100 relative overflow-hidden">
                                        <div className="absolute top-0 right-0 w-40 h-40 bg-rose-50 rounded-bl-full -mr-16 -mt-16 pointer-events-none"></div>
                                        <h3 className="font-black text-2xl text-stone-800 mb-6 flex items-center gap-3 relative z-10">
                                            <span className="text-3xl drop-shadow-sm">🔥</span> מלכות הרצף
                                        </h3>
                                        <div className="space-y-4 relative z-10">
                                            {sortedByStreak.map((u, i) => {
                                                const streak = u.taskStreak || 0;
                                                const topStreak = Math.max(sortedByStreak[0]?.taskStreak || 1, 1);
                                                const progressPct = Math.max(2, (streak / topStreak) * 100);


                                                return (
                                                <div key={u.isMe ? 'me' : u.username} className={`relative flex flex-col p-5 rounded-2xl border transition-all ${u.isMe ? 'bg-rose-50/40 border-rose-200 shadow-sm' : 'bg-stone-50 border-stone-200 hover:border-stone-300'}`}>
                                                    <div className="flex flex-wrap sm:flex-nowrap items-center justify-between mb-4 gap-3">
                                                        <div className="flex items-center gap-4">
                                                            <div className="text-3xl font-black w-10 text-center flex justify-center items-center drop-shadow-sm shrink-0">
                                                                {i===0 ? '👑' : i===1 ? '🥈' : '🥉'}
                                                            </div>
                                                            <div className="flex items-center gap-3">
                                                                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-rose-100 to-orange-100 flex items-center justify-center text-lg font-black text-rose-700 shadow-inner border-2 border-white shrink-0">
                                                                    {(u.name || 'א').charAt(0)}
                                                                </div>
                                                                <div className={`font-bold text-base md:text-lg flex items-center gap-2 ${u.isMe ? 'text-rose-800' : 'text-stone-800'}`}>
                                                                    {u.name} {u.isMe && <span className="text-[10px] bg-rose-500 text-white px-2 py-0.5 rounded-full font-bold shadow-sm">אני</span>}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="font-black text-xl text-rose-600 bg-white px-5 py-2 rounded-xl shadow-sm border border-stone-100 flex items-center gap-1.5 shrink-0" dir="ltr">
                                                            {streak} <span className="text-xl drop-shadow-sm">🔥</span>
                                                        </div>
                                                    </div>
                                                    <div className="w-full bg-stone-200/80 rounded-full h-3 relative overflow-hidden shadow-inner">
                                                        <div className={`h-full rounded-full transition-all duration-1000 ease-out ${u.isMe ? 'bg-rose-500' : i === 0 ? 'bg-gradient-to-r from-rose-400 to-orange-400' : 'bg-stone-400'}`} style={{ width: `${progressPct}%` }}></div>
                                                    </div>
                                                </div>
                                            )})}
                                            {sortedByStreak.length === 0 && <div className="text-center py-6 text-stone-400 font-medium">אין משתמשים בטבלה עדיין.</div>}
                                        </div>
                                    </div>
                                </div>


                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {activeUserData.friends.map(friend => {
                                        const liveData = liveFriends[friend.username] || {};
                                        const displayStreak = liveData.taskStreak !== undefined ? liveData.taskStreak : (friend.streak || 0);
                                        
                                        return (
                                        <div key={friend.id} className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100 cursor-pointer hover:border-purple-300 hover:shadow-lg transition-all group relative overflow-hidden active:scale-95" onClick={() => { setActiveFriend(friend); toggleModal('friend', true); }}>
                                            <div className="absolute top-0 right-0 w-20 h-20 bg-purple-50 rounded-bl-full -mr-10 -mt-10 transition-transform group-hover:scale-150 pointer-events-none"></div>
                                            <div className="flex items-center gap-4 relative z-10">
                                                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-100 to-rose-100 flex items-center justify-center text-xl font-black text-purple-700 shadow-sm border border-white">
                                                    {friend.name.charAt(0)}
                                                </div>
                                                <div className="flex-1">
                                                    <div className="font-bold text-lg text-stone-800">{friend.name}</div>
                                                    <div className="text-xs font-medium text-stone-400" dir="auto">@{friend.username}</div>
                                                </div>
                                                <div className="text-center bg-stone-50 border border-stone-200 rounded-xl px-3 py-2">
                                                    <div className="text-[10px] text-stone-500 font-bold mb-0.5">רצף</div>
                                                    <div className="font-black text-rose-500 text-lg flex items-center justify-center gap-1">
                                                        {displayStreak} <span className="text-sm">🔥</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )})}
                                    {activeUserData.friends.length === 0 && <div className="text-stone-400 text-base font-medium text-center col-span-full py-16 bg-white rounded-3xl border border-dashed border-stone-300">עדיין לא הוספת חברות לקבוצה. לחצי למעלה כדי להתחיל.</div>}
                                </div>
                            </div>
                            )
                        })()}


                        {}
                        {activeTab === 'profile' && (() => {
                            const userBadges = activeUserData.badges || [];
                            
                            return (
                            <div className="space-y-4 max-w-3xl mx-auto animate-[fadeIn_0.3s_ease-out]">
                                <div className="bg-white p-8 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-stone-100 relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-full h-40 bg-gradient-to-br from-purple-100/50 to-pink-100/50 pointer-events-none"></div>
                                    
                                    <div className="relative z-10 flex flex-col md:flex-row items-center md:items-start gap-6 mb-8 text-center md:text-right">
                                        <div className="w-24 h-24 bg-white text-purple-600 border-4 border-white shadow-md rounded-[28px] flex items-center justify-center text-4xl font-black shrink-0">
                                            {activeUserData.name.charAt(0)}
                                        </div>
                                        <div className="mt-1 md:mt-3 flex-1 flex flex-col items-center md:items-start">
                                            <h2 className="text-3xl font-black text-stone-800 tracking-tight" dir="auto">{activeUserData.name}</h2>
                                            <p className="text-stone-500 text-sm font-semibold mt-1" dir="auto">@{globalState.activeUser}</p>
                                            
                                            <div className="mt-3 bg-gradient-to-r from-purple-100 to-fuchsia-100 text-purple-800 px-4 py-2 rounded-full text-sm font-bold shadow-sm inline-flex items-center gap-2 border border-purple-200">
                                                <span>{myLevel.icon}</span> דרגה: {myLevel.title}
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 relative z-10">
                                        <button className="bg-stone-50 border border-stone-200 p-5 rounded-3xl transition-all group flex flex-col justify-center items-center hover:bg-emerald-50 hover:border-emerald-200 active:scale-95" onClick={()=>toggleModal('pointsHistory', true)}>
                                            <div className="text-4xl font-black text-emerald-500 mb-2 group-hover:scale-105 transition-transform" dir="ltr">{activeUserData.totalPoints}</div>
                                            <div className="text-xs font-bold text-stone-500 uppercase tracking-wide">סה"כ נקודות</div>
                                        </button>
                                        
                                        <button className="bg-stone-50 border border-stone-200 p-5 rounded-3xl transition-all group flex flex-col justify-center items-center hover:bg-purple-50 hover:border-purple-200 active:scale-95" onClick={()=>toggleModal('pointsHistory', true)}>
                                            <div className="text-4xl font-black text-purple-500 mb-2 group-hover:scale-105 transition-transform" dir="ltr">{activeUserData.weeklyPoints}</div>
                                            <div className="text-xs font-bold text-stone-500 uppercase tracking-wide">השבוע</div>
                                            <div className="text-[10px] text-stone-400 mt-1 font-bold tracking-wider">שיא: {activeUserData.highestWeeklyPoints || 0}</div>
                                        </button>
                                        
                                        <button className="bg-stone-50 border border-stone-200 p-5 rounded-3xl transition-all group flex flex-col justify-center items-center hover:bg-rose-50 hover:border-rose-200 active:scale-[0.98]" onClick={()=>toggleModal('streakHistory', true)}>
                                            <div className="text-4xl font-black text-rose-500 mb-2 group-hover:scale-110 transition-transform flex items-center gap-2" dir="ltr">{activeUserData.longestStreak} <span className="text-2xl drop-shadow-sm">🔥</span></div>
                                            <div className="text-xs font-bold text-stone-500 uppercase tracking-wide">שיא רצף נוכחי</div>
                                            <div className="text-[10px] text-stone-400 mt-1 font-medium">לחצי להיסטוריה</div>
                                        </button>
                                    </div>
                                    
                                    <div className="bg-white p-6 rounded-3xl border border-stone-100 shadow-sm relative z-10 mb-8">
                                        <h3 className="font-bold text-lg mb-4 text-stone-800">התפלגות למידה לפי מקצוע 📊</h3>
                                        <div className="h-64 w-full">
                                            <canvas ref={pieChartRef}></canvas>
                                        </div>
                                    </div>


                                    <div className="bg-white p-6 rounded-3xl border border-stone-100 shadow-sm relative z-10 mb-8">
                                        <h3 className="font-bold text-lg mb-4 text-stone-800">ארון התגים 🏅</h3>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            {ALL_BADGES.map(badge => {
                                                const earned = userBadges.find(b => b.id === badge.id);
                                                return (
                                                    <div key={badge.id} className={`p-4 rounded-2xl border text-center transition-all ${earned ? 'bg-gradient-to-b from-amber-50 to-orange-50 border-amber-200 shadow-sm' : 'bg-stone-50 border-stone-200 opacity-60 grayscale'}`}>
                                                        <div className="text-3xl mb-2 drop-shadow-sm">{badge.icon}</div>
                                                        <div className={`text-sm font-bold ${earned ? 'text-amber-800' : 'text-stone-500'}`}>{badge.title}</div>
                                                        <div className="text-[10px] mt-1 text-stone-500 leading-tight">{badge.description}</div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>


                                    <div className="bg-gradient-to-br from-indigo-50 to-blue-50 p-6 rounded-3xl border border-indigo-100 shadow-sm relative z-10 mb-8">
                                        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                                            <div>
                                                <h3 className="text-xl font-bold mb-2 text-indigo-800 flex items-center gap-2">
                                                    <span>📊</span> דוח התקדמות שבועי להורים
                                                </h3>
                                                <p className="text-sm text-indigo-600/80 font-medium max-w-lg">
                                                    הפיקי בלחיצה דוח מסודר שמסכם את כל הלמידה, המשימות והנקודות שצברת השבוע, כדי לשתף ולהראות את ההשקעה שלך!
                                                </p>
                                            </div>
                                            <div className="flex flex-col sm:flex-row gap-2.5 w-full sm:w-auto shrink-0">
                                                <button onClick={handleGenerateWeeklyReport} className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-3.5 rounded-xl text-sm font-bold shadow-md transition-all active:scale-95 flex items-center justify-center gap-2">
                                                    הפקת דוח להדפסה / PDF 🖨️
                                                </button>
                                                <button onClick={handleSendParentWeeklyReportWhatsApp} className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-3.5 rounded-xl text-sm font-bold shadow-md transition-all active:scale-95 flex items-center justify-center gap-2">
                                                    <span>📲</span> שליחה לוואטסאפ של ההורים
                                                </button>
                                            </div>
                                        </div>
                                    </div>


                                    <div className="bg-stone-50/70 p-6 rounded-3xl border border-stone-200 text-right relative z-10">
                                        <div className="font-bold text-base text-stone-800 border-b border-stone-200 pb-3 mb-4">הגדרות חשבון אישי</div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-[11px] font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">שם תצוגה</label>
                                                <input type="text" dir="auto" value={activeUserData.name} onChange={(e) => updateUserData({ name: e.target.value })} className="w-full p-3.5 bg-white border border-stone-200 rounded-xl text-sm outline-none font-bold focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all shadow-sm" />
                                            </div>
                                            <div>
                                                <label className="text-[11px] font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">סיסמה</label>
                                                <input type="text" dir="auto" value={activeUserData.password} onChange={(e) => updateUserData({ password: e.target.value })} className="w-full p-3.5 bg-white border border-stone-200 rounded-xl text-sm outline-none font-medium text-stone-700 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all shadow-sm" />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            )
                        })()}
                    </main>


                    {}
                    {modals.task && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-5">
                                    <h3 className="font-bold text-xl text-stone-800 flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600"><IconPlus className="w-4 h-4"/></div>
                                        הוספת שיעור / משימה
                                    </h3>
                                    <button onClick={()=>toggleModal('task',false)} className="text-stone-400 hover:text-stone-600 bg-stone-100 p-2 rounded-full transition-colors active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <form onSubmit={(e) => {
                                    e.preventDefault();
                                    handleAddTask({
                                        subjectId: e.target.subId.value, 
                                        givenDate: taskGivenDate,
                                        title: taskFormHasHW ? e.target.title.value : '',
                                        dueDate: taskFormHasHW ? (e.target.date?.value || null) : null, 
                                        dueTime: taskFormHasHW ? (e.target.time?.value || null) : null, 
                                        lessonTopic: e.target.topic.value
                                    }, taskFormHasHW);
                                }} className="space-y-3.5">
                                    
                                    <div className="flex gap-3">
                                        <div className="flex-1">
                                            <label className="text-xs font-bold text-stone-500 block mb-1 uppercase tracking-wide">מקצוע</label>
                                            <select name="subId" required className="w-full p-3 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-2xl text-sm outline-none font-bold focus:border-purple-400 transition-all cursor-pointer" onChange={(e)=>{
                                                setTaskFormSubject(e.target.value);
                                                if (!taskFormHasHW) return;
                                                const sub = activeUserData.subjects.find(s=>s.id === e.target.value);
                                                const calcDate = calculateSpecificDueDate(sub, taskGivenDate);
                                                if (calcDate) {
                                                    if(document.getElementById('taskDate')) document.getElementById('taskDate').value = calcDate.date;
                                                    if(document.getElementById('taskTime')) document.getElementById('taskTime').value = calcDate.time;
                                                } else {
                                                    if(document.getElementById('taskDate')) document.getElementById('taskDate').value = '';
                                                    if(document.getElementById('taskTime')) document.getElementById('taskTime').value = '';
                                                }
                                            }}>
                                                <option value="">מקצוע...</option>
                                                {activeUserData.subjects.map(s => <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>)}
                                            </select>
                                        </div>
                                        
                                        <div className="flex-1">
                                            <label className="text-xs font-bold text-stone-500 block mb-1 uppercase tracking-wide">תאריך השיעור / קבלה</label>
                                            <input type="date" required value={taskGivenDate} onChange={(e) => {
                                                setTaskGivenDate(e.target.value);
                                                if (!taskFormHasHW) return;
                                                const subId = document.querySelector('select[name="subId"]').value;
                                                const sub = activeUserData.subjects.find(s=>s.id === subId);
                                                const calcDate = calculateSpecificDueDate(sub, e.target.value);
                                                if (calcDate) {
                                                    if(document.getElementById('taskDate')) document.getElementById('taskDate').value = calcDate.date;
                                                    if(document.getElementById('taskTime')) document.getElementById('taskTime').value = calcDate.time;
                                                } else {
                                                    if(document.getElementById('taskDate')) document.getElementById('taskDate').value = '';
                                                    if(document.getElementById('taskTime')) document.getElementById('taskTime').value = '';
                                                }
                                            }} className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm outline-none font-medium focus:border-purple-400 transition-all shadow-sm" />
                                        </div>
                                    </div>
                                    
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <label className="text-xs font-bold text-stone-500 uppercase tracking-wide">נושא השיעור (למחולל המבחנים)</label>
                                            {pastTopics.length > 0 && <span className="text-[10px] text-purple-600 font-bold">נושאים קודמים זמינים לבחירה</span>}
                                        </div>
                                        <input 
                                            id="taskTopicInput"
                                            name="topic" 
                                            list="past-topics-list"
                                            required={false} 
                                            placeholder="למשל: אינטגרלים, אוטופיה... (או בחרי נושא קיים)" 
                                            className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm outline-none font-medium focus:border-purple-400 transition-all shadow-sm" 
                                        />
                                        <datalist id="past-topics-list">
                                            {pastTopics.map((tp, idx) => (
                                                <option key={idx} value={tp} />
                                            ))}
                                        </datalist>
                                        {pastTopics.length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                                                <span className="text-[11px] font-bold text-stone-400">נושאים שהיו:</span>
                                                {pastTopics.slice(0, 6).map((tp, idx) => (
                                                    <button 
                                                        key={idx} 
                                                        type="button" 
                                                        onClick={() => {
                                                            const input = document.getElementById('taskTopicInput');
                                                            if (input) input.value = tp;
                                                        }}
                                                        className="text-xs bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 px-2.5 py-1 rounded-xl transition-all font-medium active:scale-95">
                                                        + {tp}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>


                                    <div className="pt-2 border-t border-stone-100">
                                        <label className="text-sm font-bold text-stone-800 block mb-2">האם קיבלתם שיעורי בית?</label>
                                        <div className="flex gap-2">
                                            <button type="button" onClick={()=>setTaskFormHasHW(true)} className={`flex-1 py-3 rounded-xl border font-bold text-sm transition-all ${taskFormHasHW ? 'bg-purple-50 border-purple-200 text-purple-700 shadow-sm' : 'bg-stone-50 border-stone-200 text-stone-500 hover:bg-stone-100'}`}>כן, יש משימה</button>
                                            <button type="button" onClick={()=>setTaskFormHasHW(false)} className={`flex-1 py-3 rounded-xl border font-bold text-sm transition-all ${!taskFormHasHW ? 'bg-purple-50 border-purple-200 text-purple-700 shadow-sm' : 'bg-stone-50 border-stone-200 text-stone-500 hover:bg-stone-100'}`}>לא, רק לתעד</button>
                                        </div>
                                    </div>


                                    {taskFormHasHW && (
                                        <div className="space-y-3.5 animate-[fadeIn_0.3s_ease-out]">
                                            <div>
                                                <label className="text-xs font-bold text-stone-500 block mb-1 uppercase tracking-wide">מה צריך לעשות?</label>
                                                <input id="taskTitleInput" name="title" required={taskFormHasHW} placeholder="למשל: תרגילים 1-5 עמ 14 (ניתן להוסיף משימות נוספות לאותו נושא)" className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm outline-none font-medium focus:border-purple-400 transition-all shadow-sm" />
                                                <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
                                                    <span className="text-[11px] font-bold text-stone-400">קיצור מהיר:</span>
                                                    {['תרגול שאלות בגרות', 'דף עבודה', 'תרגילים בספר', 'חזרה למבחן'].map(preset => (
                                                        <button key={preset} type="button" onClick={() => {
                                                            const titleInput = document.getElementById('taskTitleInput');
                                                            if (titleInput) titleInput.value = preset;
                                                        }} className="text-[11px] bg-stone-100 hover:bg-stone-200 text-stone-600 px-2.5 py-1 rounded-lg transition-colors font-medium active:scale-95">
                                                            {preset}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                            
                                            <div className="bg-purple-50/50 p-3 rounded-2xl border border-purple-100">
                                                <div className="text-xs text-purple-800 font-bold mb-2 flex items-center gap-1.5"><IconCalendar className="w-4 h-4"/> הגשה (לפי החוקים שהוגדרו):</div>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <input id="taskDate" name="date" type="date" required={taskFormHasHW} className="w-full p-3 bg-white border border-purple-100 rounded-xl text-sm outline-none font-medium shadow-sm focus:border-purple-400" />
                                                    <input id="taskTime" name="time" type="time" required={taskFormHasHW} className="w-full p-3 bg-white border border-purple-100 rounded-xl text-sm outline-none font-medium shadow-sm focus:border-purple-400" />
                                                </div>
                                                <div className="text-[10px] text-purple-600/70 mt-1.5 font-medium leading-tight">אם השדות ריקים, סימן שאין חוק הגשה ליום הזה, מלאי ידנית.</div>
                                            </div>
                                        </div>
                                    )}


                                    {!taskFormHasHW && (
                                        <div className="bg-emerald-50 text-emerald-700 p-3 rounded-2xl border border-emerald-100 text-sm font-medium animate-[fadeIn_0.3s_ease-out]">
                                            <span className="font-bold block mb-1">איזה כיף! אין שיעורי בית. 🥳</span>
                                            שמירת הנושא תכניס אותו למחולל המבחנים כדי שתחזרי עליו לקראת המתכונת.
                                        </div>
                                    )}


                                    <button type="submit" className="w-full bg-stone-800 text-white rounded-2xl py-3.5 font-bold text-base shadow-md hover:bg-stone-900 transition-colors mt-2 active:scale-95">
                                        {taskFormHasHW ? 'שמירת משימה' : 'תיעוד שיעור'}
                                    </button>
                                </form>
                            </div>
                        </div>
                    )}


                    {}

                    {modals.edit && editingTask && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-5">
                                    <h3 className="font-bold text-xl text-stone-800">עריכת משימה</h3>
                                    <button type="button" onClick={()=>{ toggleModal('edit', false); setEditingTask(null); }} className="text-stone-400 bg-stone-100 p-2 rounded-full active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <form onSubmit={handleEditTask} className="space-y-3.5">
                                    <div>
                                        <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">מקצוע</label>
                                        <select name="subId" defaultValue={editingTask.subjectId} required className="w-full p-3 bg-stone-50 border border-stone-200 rounded-2xl text-sm font-bold">
                                            {activeUserData.subjects.map(s => <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">תאריך השיעור / קבלה</label>
                                        <input name="givenDate" type="date" defaultValue={editingTask.givenDate || ''} required className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm" />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">נושא השיעור</label>
                                        <input name="topic" defaultValue={editingTask.lessonTopic || ''} className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm" />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">מה צריך לעשות?</label>
                                        <input name="title" defaultValue={editingTask.title || ''} required className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm" />
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">תאריך הגשה</label>
                                            <input name="date" type="date" defaultValue={editingTask.dueDate || ''} required className="w-full p-3 bg-white border border-purple-100 rounded-xl text-sm" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">שעת הגשה</label>
                                            <input name="time" type="time" defaultValue={editingTask.dueTime || ''} required className="w-full p-3 bg-white border border-purple-100 rounded-xl text-sm" />
                                        </div>
                                    </div>
                                    {editingTask.isExamPrep && (
                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1 uppercase">שעת התחלה</label>
                                            <input name="startTime" type="time" defaultValue={editingTask.startTime || ''} className="w-full p-3 bg-white border border-stone-200 rounded-2xl text-sm" />
                                        </div>
                                    )}
                                    <button type="submit" className="w-full bg-stone-800 text-white rounded-2xl py-3.5 font-bold">שמירת עריכה</button>
                                </form>
                            </div>
                        </div>
                    )}



                    {modals.complete && activeTask && (() => {
                        const activeTaskIsLate = activeTask.dueDate && activeTask.dueTime ? (new Date() > new Date(`${activeTask.dueDate}T${activeTask.dueTime}`)) : false;
                        
                        return (
                            <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4">
                                <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 shadow-2xl relative overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                    <div className={`absolute top-0 left-0 w-full h-2 ${activeTaskIsLate ? 'bg-rose-400' : 'bg-emerald-400'}`}></div>
                                    <div className="flex justify-between items-start mb-2 mt-2">
                                        <h3 className="font-bold text-xl text-stone-800">סיום משימה:<br/><span className={activeTaskIsLate ? 'text-rose-600' : 'text-emerald-600'}>{activeTask.title}</span></h3>
                                        <button onClick={()=>{toggleModal('complete',false); setActiveTask(null);}} className="text-stone-400 bg-stone-100 p-2 rounded-full active:scale-95"><IconX className="w-4 h-4"/></button>
                                    </div>
                                    
                                    {activeTaskIsLate && (
                                        <div className="bg-rose-50 text-rose-700 p-3 rounded-xl border border-rose-100 text-xs font-bold mb-4">
                                            {activeTask.autoPenaltyApplied 
                                                ? '⚠️ שימי לב: הקנס על האיחור (-2 נקודות) כבר ירד אוטומטית.'
                                                : '⚠️ המשימה מוגשת באיחור. הרצף שלך עלול להישבר.'}
                                        </div>
                                    )}


                                    <p className="text-sm text-stone-500 mb-6 font-medium leading-relaxed">תעדי את ההבנה והקשיים שלך עכשיו, כדי שמחולל המבחנים יידע לבנות לך תוכנית חזרה מושלמת.</p>
                                    
                                    <form onSubmit={(e) => {
                                        e.preventDefault();
                                        const chosenReason = activeTaskIsLate ? (lateReason === 'אחר' ? otherLateReason : lateReason) : '';
                                        if (activeTaskIsLate && !chosenReason) {
                                            showToast('אנא בחרי סיבת איחור', 'error');
                                            return;
                                        }
                                        handleCompleteTask(activeTask, Number(e.target.rating.value), e.target.hard.value, chosenReason);
                                    }} className="space-y-6">
                                        
                                        {activeTaskIsLate && (
                                            <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200">
                                                <label className="text-sm font-bold text-stone-800 mb-3 block">למה המשימה מוגשת באיחור?</label>
                                                <div className="grid grid-cols-2 gap-2 mb-2">
                                                    {['התעצלתי', 'שכחתי', 'לא הספקתי', 'אחר'].map(reason => (
                                                        <label key={reason} className="cursor-pointer">
                                                            <input type="radio" name="lateReason" value={reason} required className="peer sr-only" onChange={(e) => setLateReason(e.target.value)} />
                                                            <div className="text-xs font-bold text-center py-2.5 px-1 border border-stone-200 bg-white rounded-lg peer-checked:bg-rose-50 peer-checked:text-rose-700 peer-checked:border-rose-200 transition-colors">
                                                                {reason}
                                                            </div>
                                                        </label>
                                                    ))}
                                                </div>
                                                {lateReason === 'אחר' && (
                                                    <input type="text" placeholder="פרטי את הסיבה כאן..." value={otherLateReason} onChange={(e)=>setOtherLateReason(e.target.value)} required className="w-full p-3 mt-2 bg-white border border-stone-200 rounded-lg text-sm outline-none focus:border-rose-400" />
                                                )}
                                            </div>
                                        )}


                                        <div>
                                            <label className="text-sm font-bold text-stone-800 mb-3 block">איך הלך בשיעורי הבית? (רמת הבנה)</label>
                                            <div className="flex gap-2 justify-between">
                                                {[1,2,3,4,5].map(n => (
                                                    <label key={n} className="flex-1 text-center cursor-pointer group">
                                                        <input type="radio" name="rating" value={n} required className="peer sr-only" />
                                                        <div className="py-3 border border-stone-200 bg-stone-50 rounded-xl peer-checked:bg-emerald-500 peer-checked:text-white peer-checked:border-emerald-600 font-bold text-base transition-all peer-checked:shadow-md active:scale-95">
                                                            {n}
                                                        </div>
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="flex justify-between text-[11px] text-stone-400 mt-2 px-1 font-bold uppercase tracking-wide">
                                                <span>חלש מאוד (1)</span>
                                                <span>הכל מובן (5)</span>
                                            </div>
                                        </div>
                                        <div className="bg-rose-50/50 p-4 rounded-2xl border border-rose-100">
                                            <label className="text-sm font-bold text-rose-700 mb-2 block flex items-center gap-2"><span>📌</span> אילו תרגילים היו קשים? (לא חובה)</label>
                                            <textarea name="hard" rows="2" placeholder="למשל: סעיף ד' בשאלה 5..." className="w-full p-4 border border-rose-200 bg-white rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-200 resize-none shadow-sm"></textarea>
                                        </div>
                                        <button type="submit" className={`w-full text-white rounded-2xl py-4 font-bold text-base shadow-md transition-all flex justify-center items-center gap-2 active:scale-95 ${activeTaskIsLate ? 'bg-stone-800 hover:bg-stone-900' : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600'}`}>
                                            {activeTaskIsLate ? 'סיום באיחור ושמירת נתונים' : 'אשרי סיום וקבלי נקודות! 🎉'}
                                        </button>
                                    </form>
                                </div>
                            </div>
                        )
                    })()}


                    {}
                    {modals.giveUp && taskToGiveUp && (
                        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-[32px] w-full max-w-sm p-8 shadow-2xl relative overflow-hidden animate-[slideUp_0.3s_ease-out] text-center">
                                <div className="text-5xl mb-4">🥺</div>
                                <h3 className="font-black text-2xl text-stone-800 mb-2">בטוחה שאת רוצה לוותר?</h3>
                                <p className="text-sm text-stone-500 mb-6 font-medium">
                                    חבל, אני יודעת שאת יכולה לעשות את זה!<br/>
                                    <span className="block mt-2 text-rose-600 font-bold bg-rose-50 p-2 rounded-xl border border-rose-100">
                                        ויתור יאפס לך את הרצף המדהים שלך ויוריד לך 10 נקודות.
                                    </span>
                                </p>
                                <div className="flex flex-col gap-3 mt-4">
                                    <button onClick={()=> { toggleModal('giveUp', false); setTaskToGiveUp(null); }} className="w-full bg-emerald-500 text-white font-bold py-3.5 rounded-xl text-sm transition-colors shadow-md hover:bg-emerald-600 active:scale-95">
                                        לא, אני אעשה את זה! 💪
                                    </button>
                                    <button onClick={handleGiveUpConfirm} className="w-full bg-stone-100 text-stone-500 font-bold py-3.5 rounded-xl text-sm transition-colors active:scale-95 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-100 border border-transparent">
                                        כן, מוותרת 🏳️ (-10)
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}


                    {modals.cancelExam && taskToCancel && (
                        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-[32px] w-full max-w-sm p-8 shadow-2xl relative overflow-hidden animate-[slideUp_0.3s_ease-out]">
                                <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center text-rose-600 mb-4 mx-auto">
                                    <IconTrash className="w-8 h-8"/>
                                </div>
                                <h3 className="font-black text-xl text-stone-800 text-center mb-2">ביטול מפגש למידה?</h3>
                                <p className="text-sm text-stone-500 text-center mb-4 font-medium">
                                    ביטול למידה שנקבעה מראש עולה <strong>4 נקודות</strong>.<br/><br/>
                                    <span className="text-rose-600 font-bold bg-rose-50 px-2 py-1.5 rounded-lg block mt-1 border border-rose-100">אזהרה: ביטול של 3 מפגשים לאותו מבחן ישבור את הרצף שלך!</span>
                                </p>
                                <div className="flex gap-3 mt-6">
                                    <button onClick={()=> { toggleModal('cancelExam', false); setTaskToCancel(null); }} className="flex-1 bg-stone-100 text-stone-600 font-bold py-3.5 rounded-xl text-sm transition-colors active:scale-95 hover:bg-stone-200">
                                        התחרטתי
                                    </button>
                                    <button onClick={handleCancelExamSessionConfirm} className="flex-[1.5] bg-rose-500 text-white font-bold py-3.5 rounded-xl text-sm transition-colors shadow-md hover:bg-rose-600 active:scale-95">
                                        כן, בטלי (-4)
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}


                    {modals.examGrade && activeExamForGrade && (
                        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-sm p-6 md:p-8 shadow-2xl relative overflow-hidden animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="font-black text-xl text-stone-800 flex items-center gap-2">
                                        📝 עדכון ציון
                                    </h3>
                                    <button onClick={()=> { toggleModal('examGrade', false); setActiveExamForGrade(null); }} className="text-stone-400 bg-stone-100 p-2 rounded-full active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <p className="text-sm text-stone-500 mb-6 font-medium">המבחן {activeExamForGrade.examName} מאחורייך. איך היה? סמני את הציון וקבלי נקודות בונוס למדד (או קנס קטן על נכשל).</p>
                                
                                <form onSubmit={handleSaveExamGrade} className="space-y-5">
                                    <div>
                                        <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">ציון במבחן (0-100)</label>
                                        <input type="number" name="grade" min="0" max="100" required className="w-full p-4 bg-stone-50 border border-stone-200 rounded-xl text-2xl outline-none font-black focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50 transition-all text-center text-emerald-600" placeholder="100" />
                                    </div>
                                    <button type="submit" className="w-full bg-emerald-500 text-white py-4 rounded-xl text-base font-bold shadow-md hover:bg-emerald-600 transition-all active:scale-95">שמירת ציון</button>
                                </form>
                            </div>
                        </div>
                    )}


                    {}
                    {modals.quickExam && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-sm p-6 md:p-8 shadow-2xl animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6">
                                    <h3 className="font-bold text-xl text-stone-800 flex items-center gap-2">
                                        📝 מבחן חדש בקליק
                                    </h3>
                                    <button onClick={()=>toggleModal('quickExam', false)} className="bg-stone-100 p-2 rounded-full text-stone-400 active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <form onSubmit={handleAddQuickExam} className="space-y-4">
                                    <div className="bg-indigo-50 p-3 rounded-xl border border-indigo-100 text-xs text-indigo-700 font-medium mb-4">
                                        אפשרות זו מוסיפה מבחן לרשימה בלי לחולל תוכנית למידה. מצוין לבחנים קטנים או אם את רוצה לנהל את הלמידה בעצמך.
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">מקצוע</label>
                                        <select name="subjectId" required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-indigo-400 font-bold">
                                            <option value="">בחרי מקצוע...</option>
                                            {activeUserData.subjects.map(s => <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">נושא / שם המבחן</label>
                                        <input type="text" name="examName" required placeholder="למשל: בוחן פתע, מתכונת..." className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-indigo-400 font-bold" />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">תאריך</label>
                                        <input type="date" name="date" required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-indigo-400 font-bold" />
                                    </div>
                                    <button type="submit" className="w-full bg-indigo-600 text-white py-4 mt-2 rounded-xl text-sm font-bold shadow-md hover:bg-indigo-700 transition-all active:scale-95">שמירת המבחן</button>
                                </form>
                            </div>
                        </div>
                    )}


                    {modals.examPlanner && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-lg p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6">
                                    <h3 className="font-bold text-xl text-stone-800 flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600"><IconBrain className="w-4 h-4"/></div>
                                        תכנון למידה למבחן
                                    </h3>
                                    <button onClick={()=>toggleModal('examPlanner',false)} className="text-stone-400 hover:text-stone-600 bg-stone-100 p-2 rounded-full transition-colors active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>


                                {examPlannerData.step === 1 ? (
                                    <form onSubmit={handleGenerateStudyPlan} className="space-y-5">
                                        <div className="bg-indigo-50 p-4 rounded-2xl border border-indigo-100 text-sm font-medium text-indigo-800 leading-relaxed">
                                            המערכת תסרוק את הלו"ז שלך ותפזר עבורך זמני למידה בחלונות הפנויים בכל הימים שנותרו עד המבחן.
                                        </div>

                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">מבחן קיים באתר</label>
                                            <select
                                                value={examPlannerData.existingExamId || ''}
                                                onChange={e => {
                                                    const id = e.target.value;
                                                    if (!id) {
                                                        setExamPlannerData({...examPlannerData, existingExamId: ''});
                                                        return;
                                                    }
                                                    const exam = (activeUserData.exams || []).find(x => x.id === id);
                                                    if (!exam) return;
                                                    setExamPlannerData({
                                                        ...examPlannerData,
                                                        existingExamId: id,
                                                        subjectId: exam.subjectId,
                                                        examName: exam.examName || '',
                                                        date: exam.date
                                                    });
                                                }}
                                                className="w-full p-4 bg-white border border-indigo-200 rounded-2xl text-sm outline-none font-bold focus:border-indigo-400 transition-all cursor-pointer"
                                            >
                                                <option value="">מבחן חדש (מילוי ידני)</option>
                                                {(activeUserData.exams || []).filter(ex => {
                                                    if (ex.grade) return false;
                                                    const d = new Date(ex.date); d.setHours(0,0,0,0);
                                                    const today = new Date(); today.setHours(0,0,0,0);
                                                    return d >= today;
                                                }).map(ex => {
                                                    const s = activeUserData.subjects.find(x => x.id === ex.subjectId);
                                                    return <option key={ex.id} value={ex.id}>{(ex.examName || 'מבחן')} — {s ? s.name : 'כללי'} — {ex.date}</option>;
                                                })}
                                            </select>
                                        </div>
                                        
                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">מקצוע המבחן</label>
                                            <select 
                                                value={examPlannerData.subjectId} 
                                                onChange={e => setExamPlannerData({...examPlannerData, subjectId: e.target.value})} 
                                                required 
                                                className="w-full p-4 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-2xl text-sm outline-none font-bold focus:border-indigo-400 transition-all cursor-pointer"
                                            >
                                                <option value="">בחרי מקצוע...</option>
                                                {activeUserData.subjects.map(s => <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>)}
                                            </select>
                                        </div>


                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">נושא / שם המבחן (למשל: מתכונת במכניקה)</label>
                                            <input 
                                                type="text" 
                                                value={examPlannerData.examName} 
                                                onChange={e => setExamPlannerData({...examPlannerData, examName: e.target.value})} 
                                                required 
                                                placeholder="על מה המבחן?"
                                                className="w-full p-4 bg-white border border-stone-200 rounded-2xl text-sm outline-none font-medium focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all shadow-sm" 
                                            />
                                        </div>


                                        <div>
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">תאריך המבחן</label>
                                            <input 
                                                type="date" 
                                                value={examPlannerData.date} 
                                                onChange={e => setExamPlannerData({...examPlannerData, date: e.target.value})} 
                                                required 
                                                min={new Date().toISOString().split('T')[0]} 
                                                className="w-full p-4 bg-white border border-stone-200 rounded-2xl text-sm outline-none font-medium focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all shadow-sm" 
                                            />
                                        </div>


                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">כמה שעות למידה?</label>
                                                <div className="flex items-center gap-2">
                                                    <input type="range" min="1" max="50" step="1" value={examPlannerData.hours} onChange={(e) => setExamPlannerData({...examPlannerData, hours: Number(e.target.value)})} className="flex-1 accent-indigo-500" />
                                                    <div className="w-12 text-center font-black text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-lg py-2">{examPlannerData.hours} ש'</div>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">בכמה מפגשים?</label>
                                                <div className="flex items-center gap-2">
                                                    <input type="range" min="1" max="20" step="1" value={examPlannerData.targetSessions} onChange={(e) => setExamPlannerData({...examPlannerData, targetSessions: Number(e.target.value)})} className="flex-1 accent-indigo-500" />
                                                    <div className="w-12 text-center font-black text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-lg py-2">{examPlannerData.targetSessions}</div>
                                                </div>
                                            </div>
                                        </div>


                                        <button type="submit" className="w-full bg-stone-800 text-white rounded-2xl py-4 font-bold text-base shadow-md hover:bg-stone-900 transition-colors mt-2 active:scale-95">
                                            בניית תוכנית אוטומטית ⚡
                                        </button>
                                    </form>
                                ) : (
                                    <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
                                        <div className="text-sm font-bold text-stone-800">
                                            <span className="text-lg">✨</span> הנה הזמנים הפנויים שמצאנו לך:
                                        </div>
                                        
                                        <div className="space-y-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar border border-stone-200 rounded-2xl p-2 bg-stone-50">
                                            {examPlannerData.sessions.length === 0 ? (
                                                <div className="text-center py-6 text-sm text-rose-500 font-bold">לא מצאנו זמן פנוי לפני המבחן! אולי הלו"ז צפוף מדי או שהמבחן מחר?</div>
                                            ) : (
                                                examPlannerData.sessions.map((ses, idx) => {
                                                    const d = new Date(ses.date);
                                                    return (
                                                        <div key={ses.id} className="bg-white p-3 rounded-xl border border-stone-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                                            <div className="flex flex-col">
                                                                <span className="text-xs font-bold text-indigo-600">מפגש {idx + 1} • יום {DAYS_HE[d.getDay()]}</span>
                                                                <input 
                                                                    type="date" 
                                                                    value={ses.date} 
                                                                    onChange={(e) => { const n = [...examPlannerData.sessions]; n[idx].date = e.target.value; setExamPlannerData({...examPlannerData, sessions: n}); }}
                                                                    className="text-sm font-bold text-stone-800 bg-transparent outline-none border-b border-dashed border-stone-300 focus:border-indigo-400 mt-1 pb-0.5" 
                                                                />
                                                            </div>
                                                            <div className="flex gap-2 items-center text-xs font-bold bg-stone-50 border border-stone-100 rounded-lg p-2 justify-center w-full sm:w-auto" dir="rtl">
                                                                <span>מ-</span>
                                                                <input type="time" value={ses.startTime} onChange={(e) => { const n = [...examPlannerData.sessions]; n[idx].startTime = e.target.value; setExamPlannerData({...examPlannerData, sessions: n}); }} className="bg-transparent outline-none text-center focus:text-indigo-600" />
                                                                <span>עד</span>
                                                                <input type="time" value={ses.endTime} onChange={(e) => { const n = [...examPlannerData.sessions]; n[idx].endTime = e.target.value; setExamPlannerData({...examPlannerData, sessions: n}); }} className="bg-transparent outline-none text-center focus:text-indigo-600" />
                                                            </div>
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>


                                        {examPlannerData.remainingMinutes > 0 && (
                                            <div className="bg-rose-50 text-rose-700 p-3 rounded-xl border border-rose-100 text-xs font-bold">
                                                ⚠️ הלו"ז עמוס! לא הצלחנו לשבץ את כל השעות שביקשת בימים הפנויים.
                                            </div>
                                        )}


                                        <div className="flex gap-3 pt-2">
                                            <button onClick={() => setExamPlannerData({...examPlannerData, step: 1})} className="flex-1 bg-stone-50 border border-stone-200 text-stone-600 font-bold py-4 rounded-xl text-sm transition-colors active:scale-95 hover:bg-stone-100">
                                                חזרה לעריכה
                                            </button>
                                            <button onClick={handleConfirmStudyPlan} disabled={examPlannerData.sessions.length === 0} className="flex-[2] bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold py-4 rounded-xl text-sm transition-all shadow-md active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
                                                אישור והוספה למשימות
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}


                    {}
                    {modals.subject && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 shadow-2xl overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6">
                                    <h3 className="font-bold text-xl text-stone-800">{editingSubject ? 'עריכת מקצוע' : 'מקצוע חדש'}</h3>
                                    <button type="button" onClick={()=>toggleModal('subject',false)} className="text-stone-400 bg-stone-100 p-2 rounded-full active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <form onSubmit={(e) => {
                                    e.preventDefault();
                                    handleSaveSubject({ id: editingSubject ? editingSubject.id : undefined, name: e.target.name.value, color: e.target.color.value, emoji: e.target.emoji.value });
                                }} className="space-y-6">
                                    <div className="grid grid-cols-5 gap-3">
                                        <div className="col-span-3">
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase">שם</label>
                                            <input name="name" defaultValue={editingSubject?.name} required placeholder="פיזיקה..." className="w-full p-4 bg-white border border-stone-200 rounded-xl text-sm outline-none font-bold shadow-sm focus:border-purple-400" />
                                        </div>
                                        <div className="col-span-1">
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase text-center">אימוג'י</label>
                                            <input name="emoji" defaultValue={editingSubject?.emoji || '📚'} maxLength="2" required className="w-full p-4 bg-white border border-stone-200 rounded-xl text-base outline-none text-center shadow-sm focus:border-purple-400" />
                                        </div>
                                        <div className="col-span-1">
                                            <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase text-center">צבע</label>
                                            <input name="color" type="color" defaultValue={editingSubject?.color || '#a855f7'} className="w-full h-14 p-0 border-0 rounded-xl cursor-pointer shadow-sm overflow-hidden" />
                                        </div>
                                    </div>


                                    <div className="bg-stone-50 p-4 md:p-5 rounded-2xl border border-stone-200">
                                        <div className="flex justify-between items-center mb-4">
                                            <div className="text-sm font-bold text-stone-800">כללי הגשה אוטומטיים:</div>
                                            <button type="button" onClick={() => setTempRules([...tempRules, { assignDay: 0, dueDay: 0, dueTime: '22:00' }])} className="text-xs bg-white border border-stone-200 px-3 py-2 rounded-lg font-bold text-purple-600 shadow-sm hover:bg-stone-50 transition-colors active:scale-95">+ כלל חדש</button>
                                        </div>
                                        <div className="space-y-3">
                                            {tempRules.map((rule, idx) => (
                                                <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-white p-2 md:p-3 rounded-xl border border-stone-200 text-xs shadow-sm">
                                                    <select value={rule.assignDay} onChange={(e) => { const n = [...tempRules]; n[idx].assignDay = e.target.value; setTempRules(n); }} className="p-2 border border-stone-100 rounded-lg bg-stone-50 flex-1 outline-none font-bold focus:border-purple-300">
                                                        {DAYS_HE.map((d,i)=><option key={i} value={i}>מיום {d}</option>)}
                                                    </select>
                                                    <span className="text-stone-300 font-black px-1 hidden sm:inline">עד</span>
                                                    <select value={rule.dueDay} onChange={(e) => { const n = [...tempRules]; n[idx].dueDay = e.target.value; setTempRules(n); }} className="p-2 border border-stone-100 rounded-lg bg-stone-50 flex-1 outline-none font-bold focus:border-purple-300">
                                                        {DAYS_HE.map((d,i)=><option key={i} value={i}>יום {d}</option>)}
                                                    </select>
                                                    <input type="time" value={rule.dueTime} onChange={(e) => { const n = [...tempRules]; n[idx].dueTime = e.target.value; setTempRules(n); }} className="p-2 border border-stone-100 rounded-lg bg-stone-50 w-20 outline-none font-bold text-center focus:border-purple-300" />
                                                    <button type="button" onClick={() => setTempRules(tempRules.filter((_, i) => i !== idx))} className="text-rose-400 hover:text-rose-600 p-2 bg-stone-50 rounded-lg w-full sm:w-auto flex justify-center active:scale-95"><IconX className="w-4 h-4"/></button>
                                                </div>
                                            ))}
                                            {tempRules.length === 0 && <div className="text-xs text-stone-400 text-center py-2 font-medium">לא הוגדרו כללים למקצוע זה. הגשה תצטרך להיות מוגדרת ידנית בכל פעם.</div>}
                                        </div>
                                    </div>
                                    <button type="submit" className="w-full bg-stone-800 text-white rounded-2xl py-4 font-bold text-sm shadow-md hover:bg-stone-900 transition-colors active:scale-95">שמירת מקצוע</button>
                                </form>
                            </div>
                        </div>
                    )}


                    {modals.addAnchor && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-sm p-6 md:p-8 shadow-2xl animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6">
                                    <h3 className="font-bold text-xl text-stone-800">הוספת עוגן - יום {DAYS_HE[activeDayIndex]}</h3>
                                    <button onClick={()=>toggleModal('addAnchor',false)} className="bg-stone-100 p-2 rounded-full text-stone-400 active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <form onSubmit={handleAddAnchor} className="space-y-4">
                                    <div><label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">מה יש לך קבוע? (חוג, אימון...)</label><input type="text" name="title" required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-purple-400 font-bold" /></div>
                                    <div className="flex gap-3">
                                        <div className="flex-1"><label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">התחלה</label><input type="time" name="start" required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-purple-400 font-bold" /></div>
                                        <div className="flex-1"><label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">סיום</label><input type="time" name="end" required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-purple-400 font-bold" /></div>
                                    </div>
                                    <button type="submit" className="w-full bg-stone-800 text-white py-4 mt-2 rounded-xl text-sm font-bold shadow-md hover:bg-stone-900 transition-colors active:scale-95">הוספה ללו"ז השבועי</button>
                                </form>
                            </div>
                        </div>
                    )}


                    {}
                    {modals.addFriend && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-sm p-6 md:p-8 shadow-2xl animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6">
                                    <h3 className="font-bold text-xl text-stone-800">הוספת חברה</h3>
                                    <button onClick={()=>toggleModal('addFriend',false)} className="bg-stone-100 p-2 rounded-full text-stone-400 active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <form onSubmit={handleAddFriend} className="space-y-4">
                                    <div>
                                        <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">שם משתמש של החברה</label>
                                        <input type="text" name="username" dir="auto" placeholder="הקלידי שם משתמש..." required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-purple-400 font-bold" />
                                    </div>
                                    <button type="submit" className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-4 mt-2 rounded-xl text-sm font-bold shadow-md hover:from-purple-600 hover:to-pink-600 transition-all active:scale-95">שליחת בקשת חברות</button>
                                </form>
                            </div>
                        </div>
                    )}


                    {modals.pointsHistory && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex flex-col justify-end md:justify-center items-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 h-[85vh] md:max-h-[70vh] flex flex-col shadow-2xl animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6 pb-4 border-b border-stone-100">
                                    <h3 className="font-bold text-xl text-stone-800">היסטוריית נקודות 🏆</h3>
                                    <button onClick={()=>toggleModal('pointsHistory',false)} className="bg-stone-100 p-2 rounded-full text-stone-500 hover:bg-stone-200 transition-colors active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <div className="overflow-y-auto flex-1 space-y-3 pr-2 custom-scrollbar">
                                    {safePointsHistory.length === 0 ? <div className="text-center py-10 text-sm text-stone-400 font-medium">אין היסטוריה עדיין. בצעי משימות כדי לצבור נקודות!</div> : 
                                    [...safePointsHistory].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(log => (
                                        <div key={log.id} className={`p-4 rounded-2xl border-r-[6px] shadow-[0_2px_10px_-2px_rgba(0,0,0,0.02)] ${log.points > 0 ? 'bg-emerald-50/50 border-emerald-400 border-l border-y border-stone-100' : log.points === 0 ? 'bg-stone-50 border-stone-400 border-l border-y' : 'bg-rose-50/50 border-rose-400 border-l border-y border-stone-100'}`}>
                                            <div className="flex justify-between items-start font-bold text-sm mb-1.5 text-stone-800">
                                                <div className="flex flex-col">
                                                    <span className="flex items-center gap-1.5">
                                                        <span className="text-xs bg-white px-1.5 py-0.5 rounded shadow-sm border border-stone-200">{log.subjectEmoji} {log.subjectName}</span>
                                                    </span>
                                                    <span className="mt-1">{log.taskTitle}</span>
                                                </div>
                                                <span className={`${log.points > 0 ? 'text-emerald-600 bg-emerald-100' : log.points === 0 ? 'text-stone-600 bg-stone-200' : 'text-rose-600 bg-rose-100'} px-2 py-0.5 rounded-lg shadow-sm whitespace-nowrap`} dir="ltr">{log.points > 0 ? '+'+log.points : log.points}</span>
                                            </div>
                                            <div className="text-[10px] font-bold text-stone-400 mb-2" dir="ltr">{new Date(log.date).toLocaleString('he-IL')}</div>
                                            <div className={`text-xs font-medium p-2 rounded-lg ${log.points > 0 ? 'bg-emerald-100/30 text-emerald-700' : log.points === 0 ? 'bg-stone-200/50 text-stone-700' : 'bg-rose-100/30 text-rose-700'}`}>{log.details}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}


                    {modals.streakHistory && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex flex-col justify-end md:justify-center items-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 h-[85vh] md:max-h-[70vh] flex flex-col shadow-2xl animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                <div className="flex justify-between items-center mb-6 pb-4 border-b border-stone-100">
                                    <h3 className="font-bold text-xl text-stone-800">היסטוריית רצפים 🔥</h3>
                                    <button onClick={()=>toggleModal('streakHistory',false)} className="bg-stone-100 p-2 rounded-full text-stone-500 hover:bg-stone-200 transition-colors active:scale-95"><IconX className="w-4 h-4"/></button>
                                </div>
                                <div className="overflow-y-auto flex-1 space-y-4 pr-2 custom-scrollbar">
                                    
                                    {activeUserData.taskStreak > 0 && (
                                        <div className="p-5 rounded-2xl border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50 flex flex-col shadow-sm relative overflow-hidden">
                                            <div className="absolute top-0 right-0 w-20 h-20 bg-white/40 rounded-bl-full -mr-10 -mt-10 pointer-events-none"></div>
                                            <div className="flex justify-between items-center mb-2 relative z-10">
                                                <div className="font-black text-sm text-purple-800 uppercase tracking-wide">רצף פעיל עכשיו!</div>
                                                <div className="text-3xl font-black text-purple-600 drop-shadow-sm" dir="ltr">{activeUserData.taskStreak}</div>
                                            </div>
                                            <div className="text-xs font-bold text-purple-600/70 mb-3 relative z-10" dir="ltr">
                                                התחיל ב: {new Date(activeUserData.currentStreakStart).toLocaleDateString('he-IL')}
                                            </div>
                                            {activeUserData.currentStreakEmojis && activeUserData.currentStreakEmojis.length > 0 && (
                                                <div className="bg-white/60 p-2 rounded-xl text-sm flex flex-wrap gap-1.5 border border-purple-100/50 relative z-10">
                                                    <span className="text-xs font-bold text-purple-800/60 w-full mb-1">הגשת משימות במקצועות:</span>
                                                    {activeUserData.currentStreakEmojis.map((em, i) => <span key={i} className="text-[10px] bg-white px-1.5 py-0.5 rounded shadow-sm text-purple-700">{em}</span>)}
                                                </div>
                                            )}
                                        </div>
                                    )}


                                    {safeStreakHistory.length === 0 ? (
                                        activeUserData.taskStreak === 0 && <div className="text-center py-10 text-sm text-stone-400 font-medium">עדיין לא נשבר לך רצף (או שעוד לא התחלת)!</div>
                                    ) : (
                                        <>
                                            <div className="text-sm font-bold text-stone-400 mt-4 mb-2">רצפים מהעבר:</div>
                                            {[...safeStreakHistory].sort((a,b)=>new Date(b.endDate)-new Date(a.endDate)).map(log => (
                                                <div key={log.id} className="p-4 rounded-2xl border border-stone-200 bg-stone-50 flex flex-col shadow-sm">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <div>
                                                            <div className="text-[10px] font-bold text-stone-400 uppercase tracking-wide mb-1">תאריכים</div>
                                                            <div className="text-xs font-bold text-stone-600" dir="ltr">
                                                                {new Date(log.startDate).toLocaleDateString('he-IL')} <br/><span className="text-stone-400">עד</span> {new Date(log.endDate).toLocaleDateString('he-IL')}
                                                            </div>
                                                        </div>
                                                        <div className="text-2xl font-black text-stone-400 drop-shadow-sm" dir="ltr">{log.length}</div>
                                                    </div>
                                                    {log.emojis && log.emojis.length > 0 && (
                                                        <div className="mt-2 pt-2 border-t border-stone-200/60 text-[10px] flex flex-wrap gap-1.5 opacity-70">
                                                            {log.emojis.map((em, i) => <span key={i} className="bg-white px-1.5 py-0.5 rounded border border-stone-200 shadow-sm">{em}</span>)}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}


                    {modals.friend && activeFriend && (() => {
                        const liveData = liveFriends[activeFriend.username] || {};
                        const displayStreak = liveData.taskStreak !== undefined ? liveData.taskStreak : (activeFriend.streak || 0);
                        const displayPoints = liveData.totalPoints !== undefined ? liveData.totalPoints : (activeFriend.points || 0);
                        const allFriendTasks = liveData.tasks || activeFriend.tasks || [];
                        const pendingTasks = allFriendTasks.filter(t => !t.completed);
                        const completedCount = allFriendTasks.filter(t => t.completed).length;
                        
                        return (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md md:max-w-lg p-6 md:p-8 text-center shadow-2xl border border-stone-100 relative overflow-hidden animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8 max-h-[90vh] overflow-y-auto custom-scrollbar">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-purple-50 rounded-bl-full -mr-10 -mt-10 pointer-events-none"></div>
                                <button onClick={()=>toggleModal('friend', false)} className="absolute top-4 left-4 bg-stone-50 p-2 rounded-full text-stone-400 z-10 active:scale-95"><IconX className="w-4 h-4"/></button>
                                
                                <div className="w-20 h-20 bg-gradient-to-br from-purple-100 to-rose-100 rounded-[28px] mx-auto mb-3 flex items-center justify-center text-3xl font-black text-purple-600 shadow-inner relative z-10">{activeFriend.name.charAt(0)}</div>
                                <h3 className="font-black text-2xl text-stone-800 relative z-10">{activeFriend.name}</h3>
                                <p className="text-xs font-bold text-stone-400 mb-5 relative z-10" dir="auto">@{activeFriend.username}</p>
                                
                                <div className="grid grid-cols-3 gap-3 mb-6 relative z-10">
                                    <div className="bg-stone-50/80 p-3 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">מד משימות</div>
                                        <div className="text-rose-500 font-black text-xl">{displayStreak} 🔥</div>
                                    </div>
                                    <div className="bg-stone-50/80 p-3 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">נקודות</div>
                                        <div className="text-emerald-600 font-black text-xl">{displayPoints}</div>
                                    </div>
                                    <div className="bg-stone-50/80 p-3 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">הושלמו</div>
                                        <div className="text-purple-600 font-black text-xl">{completedCount} ✅</div>
                                    </div>
                                </div>


                                <div className="text-right bg-stone-50 p-4 md:p-5 rounded-2xl mb-6 border border-stone-200 relative z-10">
                                    <div className="flex justify-between items-center mb-3">
                                        <h4 className="font-bold text-sm text-stone-800 flex items-center gap-2">
                                            <span>📋</span> כל המשימות שפתוחות אצלה ({pendingTasks.length}):
                                        </h4>
                                    </div>
                                    
                                    {pendingTasks.length > 0 ? (
                                        <div className="space-y-2.5 max-h-60 overflow-y-auto custom-scrollbar pr-0.5">
                                            {pendingTasks.map((pt, i) => {
                                                const countdown = pt.dueDate ? getTaskCountdown(pt.dueDate, pt.dueTime) : null;
                                                return (
                                                    <div key={pt.id || i} className="bg-white p-3 rounded-xl border border-stone-200/70 shadow-xs flex flex-col gap-2">
                                                        <div className="flex items-start justify-between gap-2">
                                                            <div className="flex-1">
                                                                <div className="font-bold text-stone-800 text-sm">{pt.title}</div>
                                                                {pt.lessonTopic && <div className="text-xs text-stone-400 mt-0.5 font-medium">נושא: {pt.lessonTopic}</div>}
                                                            </div>
                                                            <button 
                                                                onClick={() => handleCopyFriendTask(pt)} 
                                                                className="bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-2.5 py-1.5 rounded-xl border border-purple-200 transition-colors flex items-center gap-1 active:scale-95 shrink-0"
                                                                title="העתק משימה זו לרשימה שלי">
                                                                <IconCopy className="w-3.5 h-3.5" /> העתק אליי
                                                            </button>
                                                        </div>
                                                        <div className="flex items-center gap-2 flex-wrap text-[11px] pt-1.5 border-t border-stone-100">
                                                            {countdown && (
                                                                <span className={`px-2 py-0.5 rounded-md font-bold ${countdown.badgeClass}`}>
                                                                    {countdown.text}
                                                                </span>
                                                            )}
                                                            {pt.dueDate && (
                                                                <span className="text-stone-500 font-medium" dir="rtl">
                                                                    📅 להגשה: {new Date(pt.dueDate).toLocaleDateString('he-IL')} {pt.dueTime || ''}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="text-xs text-stone-400 font-medium italic text-center py-4 bg-white rounded-xl border border-dashed border-stone-200">
                                            אין משימות פתוחות כרגע. הכל נקי! 🌟
                                        </div>
                                    )}
                                </div>


                                <div className="space-y-2.5 relative z-10">
                                    <a 
                                        href={`https://wa.me/?text=${encodeURIComponent(`היי ${activeFriend.name}! מה איתך ועם המשימות? בואי נעשה סשן למידה ביחד עכשיו דרך StudyStreak! 📚✨`)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3.5 rounded-xl shadow-md text-sm transition-all flex items-center justify-center gap-2 active:scale-95">
                                        <span>💬</span> למידה משותפת בוואטסאפ
                                    </a>
                                    <button onClick={() => handleSendNudge(activeFriend.username)} className="w-full bg-stone-800 hover:bg-stone-900 text-white font-bold py-3 rounded-xl shadow-md text-sm transition-all flex items-center justify-center gap-2 active:scale-95">
                                        תזכורת "מה עם השיעורים?" באפליקציה 🔔
                                    </button>
                                    <button onClick={()=>{ handleRemoveFriend(activeFriend.id); }} className="w-full bg-white text-rose-500 font-bold py-2.5 rounded-xl border border-rose-100 text-xs hover:bg-rose-50 transition-colors active:scale-95">
                                        הסרת חברה מהרשימה
                                    </button>
                                </div>
                            </div>
                        </div>
                        );
                    })()}

                    {modals.notificationHelp && (
                        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-xs z-[80] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]"
                             onClick={() => toggleModal('notificationHelp', false)}>
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 shadow-2xl relative overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.25s_ease-out] pb-safe-bottom md:pb-6 text-right"
                                 onClick={(e) => e.stopPropagation()}>
                                <div className="w-12 h-1.5 bg-stone-200 rounded-full mx-auto mb-4 md:hidden"></div>
                                
                                <div className="flex justify-between items-start mb-4 pb-3 border-b border-stone-100">
                                    <div className="flex items-center gap-2.5">
                                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 text-white flex items-center justify-center text-xl shadow-sm">🔔</div>
                                        <div>
                                            <h3 className="font-bold text-lg text-stone-800 leading-snug">איך לאפשר התראות בטלפון?</h3>
                                            <p className="text-xs text-stone-400">מדריך קצר וברור של 10 שניות</p>
                                        </div>
                                    </div>
                                    <button onClick={() => toggleModal('notificationHelp', false)} className="text-stone-400 bg-stone-100 hover:bg-stone-200 p-2 rounded-full active:scale-95 transition-colors">
                                        <IconX className="w-4 h-4"/>
                                    </button>
                                </div>

                                {(() => {
                                    const isStandalone = (typeof window !== 'undefined') && (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);
                                    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'not_supported';
                                    return (
                                        <div className="p-3 bg-stone-50 rounded-2xl mb-4 border border-stone-200 text-[11px] text-stone-600 flex flex-col gap-1 shadow-xs">
                                            <div className="font-bold text-stone-800 text-xs flex items-center gap-1">
                                                <span>🔍</span> זיהוי מצב המכשיר שלך:
                                            </div>
                                            <div className="flex justify-between">
                                                <span>מכשיר שזוהה:</span>
                                                <b className="text-stone-800">{isIOSDevice ? 'אייפון (iOS) 🍎' : 'אנדרואיד / מחשב 🤖'}</b>
                                            </div>
                                            <div className="flex justify-between">
                                                <span>נפתח ממסך הבית (אפליקציה):</span>
                                                <b className={isStandalone ? 'text-emerald-600' : 'text-amber-600'}>{isStandalone ? 'כן (מעולה!) ✅' : 'לא (פתוח בדפדפן הרגיל) ⚠️'}</b>
                                            </div>
                                            <div className="flex justify-between">
                                                <span>הרשאת התראות בדפדפן:</span>
                                                <b className={perm === 'granted' ? 'text-emerald-600' : perm === 'denied' ? 'text-rose-600' : 'text-amber-600'}>
                                                    {perm === 'granted' ? 'מאושר ✅' : perm === 'denied' ? 'חסום ❌' : perm === 'not_supported' ? 'לא נתמך בדפדפן זה ❌' : 'טרם התבקש ⏳'}
                                                </b>
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Tabs */}
                                <div className="flex gap-2 p-1 bg-stone-100 rounded-2xl mb-4">
                                    <button 
                                        type="button"
                                        onClick={() => setNotificationHelpTab('ios')}
                                        className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${notificationHelpTab === 'ios' ? 'bg-white text-purple-900 shadow-xs' : 'text-stone-500 hover:text-stone-800'}`}>
                                        <span>🍎</span> אייפון (iPhone)
                                    </button>
                                    <button 
                                        type="button"
                                        onClick={() => setNotificationHelpTab('android')}
                                        className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${notificationHelpTab === 'android' ? 'bg-white text-indigo-900 shadow-xs' : 'text-stone-500 hover:text-stone-800'}`}>
                                        <span>🤖</span> אנדרואיד / כרום
                                    </button>
                                </div>

                                {notificationHelpTab === 'ios' ? (
                                    <div className="space-y-3.5 text-xs text-stone-700">
                                        <div className="p-3 bg-purple-50 rounded-2xl border border-purple-200 text-purple-900 font-medium leading-relaxed">
                                            באייפון (iOS), אפל מאפשרת קבלת התראות מאתרים <b>רק לאחר שמוסיפים את האתר למסך הבית</b>.
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-start gap-2.5 p-2.5 bg-stone-50 rounded-xl border border-stone-200">
                                                <span className="w-6 h-6 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">1</span>
                                                <div>
                                                    <div className="font-bold text-stone-800">לחצי על כפתור השיתוף (Share)</div>
                                                    <div className="text-stone-500 mt-0.5">בתחתית מסך ספארי, לחצי על סמל הריבוע עם החץ למעלה ⎋.</div>
                                                </div>
                                            </div>

                                            <div className="flex items-start gap-2.5 p-2.5 bg-stone-50 rounded-xl border border-stone-200">
                                                <span className="w-6 h-6 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">2</span>
                                                <div>
                                                    <div className="font-bold text-stone-800">בחרי "הוסף למסך הבית" ➕</div>
                                                    <div className="text-stone-500 mt-0.5">גללי מעט בתפריט ולחצי על <b>"הוסף למסך הבית" (Add to Home Screen)</b> ואז על <b>"הוסף"</b>.</div>
                                                </div>
                                            </div>

                                            <div className="flex items-start gap-2.5 p-2.5 bg-stone-50 rounded-xl border border-stone-200">
                                                <span className="w-6 h-6 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">3</span>
                                                <div>
                                                    <div className="font-bold text-stone-800">פתחי את האפליקציה ממסך הבית</div>
                                                    <div className="text-stone-500 mt-0.5">צאי מספארי, פתחי את האייקון <b>StudyStreak</b> ממסך הבית, לחצי <b>"בדיקה"</b> ואשרי התראות!</div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="p-3 bg-amber-50 rounded-2xl border border-amber-200 text-stone-600 text-[11px] leading-relaxed">
                                            <b>כבר פתחת ממסך הבית ועדיין חסום?</b><br/>
                                            כנסי ל-<b>הגדרות האייפון ⚙️</b> ➔ גללי למטה ברשימת האפליקציות אל <b>StudyStreak</b> (או <b>Safari</b>) ➔ <b>התראות (Notifications)</b> ➔ הפעילי את <b>"אפשר התראות"</b>.
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-3.5 text-xs text-stone-700">
                                        <div className="p-3 bg-indigo-50 rounded-2xl border border-indigo-200 text-indigo-900 font-medium leading-relaxed">
                                            באנדרואיד ניתן לאפשר התראות ישירות מתוך הדפדפן בשתי לחיצות:
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-start gap-2.5 p-2.5 bg-stone-50 rounded-xl border border-stone-200">
                                                <span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">1</span>
                                                <div>
                                                    <div className="font-bold text-stone-800">לחצי על סמל המנעול 🔒 ליד כתובת האתר</div>
                                                    <div className="text-stone-500 mt-0.5">בראש הדפדפן (משמאל לכתובת האתר) לחצי על סמל המנעול או כפתור הגדרות האתר.</div>
                                                </div>
                                            </div>

                                            <div className="flex items-start gap-2.5 p-2.5 bg-stone-50 rounded-xl border border-stone-200">
                                                <span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">2</span>
                                                <div>
                                                    <div className="font-bold text-stone-800">שני את "התראות" ל-מאופשר (Allow) ✅</div>
                                                    <div className="text-stone-500 mt-0.5">לחצי על <b>"הרשאות" (Permissions)</b> והעבירי את מתג <b>"התראות"</b> למצב פעיל.</div>
                                                </div>
                                            </div>

                                            <div className="flex items-start gap-2.5 p-2.5 bg-stone-50 rounded-xl border border-stone-200">
                                                <span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">3</span>
                                                <div>
                                                    <div className="font-bold text-stone-800">רענני את העמוד</div>
                                                    <div className="text-stone-500 mt-0.5">משכי את המסך קלות כלפי מטה לרענון — וההתראות יפעלו כרגיל ברקע!</div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="p-3 bg-amber-50 rounded-2xl border border-amber-200 text-stone-600 text-[11px] leading-relaxed">
                                            <b>אם כרום חסום בהגדרות הטלפון הכלליות:</b><br/>
                                            הגדרות הטלפון ⚙️ ➔ <b>אפליקציות (Apps)</b> ➔ <b>Chrome</b> ➔ <b>התראות</b> ➔ הפעילי את המתג הראשי.
                                        </div>
                                    </div>
                                )}

                                <div className="mt-5 pt-3 border-t border-stone-100 flex gap-2">
                                    <button 
                                        type="button"
                                        onClick={() => {
                                            toggleModal('notificationHelp', false);
                                            setTimeout(testInstantNotification, 200);
                                        }}
                                        className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white rounded-2xl font-bold text-xs shadow-md active:scale-95 transition-all flex items-center justify-center gap-1.5">
                                        <span>🔄</span> ניסיתי, בדוק שוב עכשיו!
                                    </button>
                                    <button 
                                        type="button"
                                        onClick={() => toggleModal('notificationHelp', false)}
                                        className="px-4 py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-2xl font-bold text-xs transition-colors active:scale-95">
                                        סגירה
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {taskActionsMenu && (() => {
                        const task = taskActionsMenu;
                        const sub = (activeUserData.subjects || []).find(s => s.id === task.subjectId);
                        const subjectName = sub ? `${sub.emoji || ''} ${sub.name}` : 'כללי';
                        const countdown = task.dueDate ? getTaskCountdown(task.dueDate, task.dueTime) : null;
                        const isLate = task.dueDate && task.dueTime ? (new Date() > new Date(`${task.dueDate}T${task.dueTime}`)) : false;

                        return (
                            <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-xs z-[75] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]"
                                 onClick={() => setTaskActionsMenu(null)}>
                                <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 shadow-2xl relative overflow-hidden animate-[slideUp_0.25s_ease-out] pb-safe-bottom md:pb-6"
                                     onClick={(e) => e.stopPropagation()}>
                                    <div className="w-12 h-1.5 bg-stone-200 rounded-full mx-auto mb-4 md:hidden"></div>
                                    
                                    <div className="flex justify-between items-start mb-4 pb-3 border-b border-stone-100">
                                        <div className="flex-1 pr-1">
                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                <span className="text-xs font-bold px-2.5 py-0.5 rounded-lg bg-stone-100 text-stone-700">
                                                    {subjectName}
                                                </span>
                                                {countdown && (
                                                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border ${countdown.badgeClass}`}>
                                                        {countdown.text}
                                                    </span>
                                                )}
                                                {isLate && (
                                                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-100">
                                                        באיחור
                                                    </span>
                                                )}
                                            </div>
                                            <h3 className="font-bold text-lg text-stone-800 leading-snug">{task.title}</h3>
                                            {task.lessonTopic && <div className="text-xs text-stone-400 mt-0.5 font-medium">נושא: {task.lessonTopic}</div>}
                                        </div>
                                        <button onClick={() => setTaskActionsMenu(null)} className="text-stone-400 bg-stone-100 hover:bg-stone-200 p-2 rounded-full active:scale-95 transition-colors">
                                            <IconX className="w-4 h-4"/>
                                        </button>
                                    </div>

                                    <div className="space-y-2">
                                        <button 
                                            onClick={() => {
                                                setEditingTask(task);
                                                toggleModal('edit', true);
                                                setTaskActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-amber-50 hover:text-amber-800 text-stone-700 border border-stone-200 hover:border-amber-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">✏️</span>
                                                <span>עריכת משימה ותאריכים</span>
                                            </div>
                                            <span className="text-stone-400 text-xs">שינוי פרטים</span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                handleAddTaskToCalendar(task);
                                                setTaskActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-indigo-50 hover:text-indigo-800 text-stone-700 border border-stone-200 hover:border-indigo-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">📅</span>
                                                <span>הוספה ליומן עם תזכורות</span>
                                            </div>
                                            <span className="text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md text-[11px] font-semibold">קובץ ICS ליומן</span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                toggleWhatsAppTaskReminder(task);
                                                setTaskActionsMenu(null);
                                            }}
                                            className={`w-full flex items-center justify-between p-3.5 rounded-2xl border transition-all font-bold text-sm active:scale-98 shadow-xs ${
                                                task.whatsappRemindersEnabled 
                                                    ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border-emerald-200' 
                                                    : 'bg-gradient-to-r from-emerald-50 to-teal-50 hover:from-emerald-100 hover:to-teal-100 text-emerald-900 border-emerald-200'
                                            }`}>
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">{task.whatsappRemindersEnabled ? '🛑' : '💬'}</span>
                                                <span>{task.whatsappRemindersEnabled ? 'ביטול תזכורות וואטסאפ' : 'הפעלת תזכורות וואטסאפ ✨'}</span>
                                            </div>
                                            <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                                                task.whatsappRemindersEnabled ? 'bg-emerald-200 text-emerald-800' : 'bg-emerald-100 text-emerald-700'
                                            }`}>
                                                {task.whatsappRemindersEnabled ? 'פעיל בוואטסאפ' : 'לוח זמנים חכם 📲'}
                                            </span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                const shareText = `שיעורי בית ב${sub?.name || 'כללי'}: ${task.title}${task.lessonTopic ? ` (נושא: ${task.lessonTopic})` : ''} - להגשה עד ${task.dueDate ? new Date(task.dueDate).toLocaleDateString('he-IL') : ''} ${task.dueTime || ''}`;
                                                window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank');
                                                setTaskActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-emerald-50 hover:text-emerald-800 text-stone-700 border border-stone-200 hover:border-emerald-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">💬</span>
                                                <span>שיתוף בוואטסאפ עם חברות</span>
                                            </div>
                                            <span className="text-stone-400 text-xs">שליחת קישור</span>
                                        </button>

                                        {!task.isExamPrep ? (
                                            <button 
                                                onClick={() => {
                                                    setTaskToGiveUp(task);
                                                    toggleModal('giveUp', true);
                                                    setTaskActionsMenu(null);
                                                }}
                                                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-rose-50 hover:text-rose-700 text-stone-600 border border-stone-200 hover:border-rose-200 transition-all font-bold text-sm active:scale-98">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">🏳️</span>
                                                    <span>ויתרתי על המשימה</span>
                                                </div>
                                                <span className="text-rose-500 text-xs">-1 נק'</span>
                                            </button>
                                        ) : (
                                            <button 
                                                onClick={() => {
                                                    setTaskToCancel(task);
                                                    toggleModal('cancelExam', true);
                                                    setTaskActionsMenu(null);
                                                }}
                                                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-rose-50 hover:text-rose-700 text-stone-600 border border-stone-200 hover:border-rose-200 transition-all font-bold text-sm active:scale-98">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">🗑️</span>
                                                    <span>ביטול מפגש למידה זה</span>
                                                </div>
                                                <span className="text-rose-500 text-xs">ביטול</span>
                                            </button>
                                        )}
                                    </div>

                                    <div className="mt-4 pt-3 border-t border-stone-100">
                                        <button 
                                            onClick={() => setTaskActionsMenu(null)}
                                            className="w-full py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-2xl font-bold text-sm transition-colors active:scale-95">
                                            סגירה
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {isMoreMenuOpen && (
                        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-xs z-[75] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]"
                             onClick={() => setIsMoreMenuOpen(false)}>
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-lg p-6 md:p-8 shadow-2xl relative overflow-hidden animate-[slideUp_0.25s_ease-out] pb-safe-bottom md:pb-8"
                                 onClick={(e) => e.stopPropagation()}>
                                <div className="w-12 h-1.5 bg-stone-200 rounded-full mx-auto mb-4 md:hidden"></div>
                                
                                <div className="flex justify-between items-center mb-6 pb-3 border-b border-stone-100">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-2xl">✨</span>
                                        <div>
                                            <h3 className="font-bold text-xl text-stone-800">עוד אפשרויות וכלים</h3>
                                            <p className="text-xs text-stone-400 font-medium">מעבר מהיר לעמודים ודוחות נוספים</p>
                                        </div>
                                    </div>
                                    <button onClick={() => setIsMoreMenuOpen(false)} className="text-stone-400 bg-stone-100 hover:bg-stone-200 p-2 rounded-full active:scale-95 transition-colors">
                                        <IconX className="w-4 h-4"/>
                                    </button>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                                    {[
                                        { id: 'analytics', title: 'סטטיסטיקה ודוחות', desc: 'ניתוח הבנה, שעות למידה, מקצועות וציונים', icon: '📊', color: 'from-purple-500/10 to-indigo-500/10 hover:border-purple-300' },
                                        { id: 'lesson_log', title: 'יומן שיעורים', desc: 'תיעוד כל השיעורים והנושאים שנלמדו השנה', icon: '📖', color: 'from-blue-500/10 to-cyan-500/10 hover:border-blue-300' },
                                        { id: 'schedule', title: 'לו"ז וזמנים', desc: 'מערכת שעות, שעות שקטות ועוגנים קבועים', icon: '📅', color: 'from-amber-500/10 to-orange-500/10 hover:border-amber-300' },
                                        { id: 'profile', title: 'פרופיל ותגים', desc: 'צפייה ברצף, בהישגים ובמדליות שלך', icon: '👤', color: 'from-pink-500/10 to-rose-500/10 hover:border-pink-300' },
                                        { id: 'settings', title: 'הגדרות מערכת', desc: 'ניהול מקצועות, חוקי ניקוד ואיפוס נתונים', icon: '⚙️', color: 'from-stone-500/10 to-stone-600/10 hover:border-stone-300' }
                                    ].map(item => {
                                        const isSelected = activeTab === item.id;
                                        return (
                                            <button
                                                key={item.id}
                                                onClick={() => {
                                                    setActiveTab(item.id);
                                                    setIsMoreMenuOpen(false);
                                                }}
                                                className={`p-4 rounded-2xl border text-right transition-all flex items-start gap-3.5 bg-gradient-to-br ${item.color} active:scale-98 ${
                                                    isSelected ? 'border-purple-500 ring-2 ring-purple-200 shadow-sm bg-purple-50/50' : 'border-stone-200/80 hover:bg-stone-50/80'
                                                }`}>
                                                <span className="text-2xl shrink-0 mt-0.5">{item.icon}</span>
                                                <div className="flex-1">
                                                    <div className="font-bold text-stone-800 text-sm flex items-center justify-between">
                                                        <span>{item.title}</span>
                                                        {isSelected && <span className="text-[11px] font-extrabold text-purple-600 bg-purple-100 px-2 py-0.5 rounded-full">נוכחי</span>}
                                                    </div>
                                                    <div className="text-xs text-stone-500 mt-1 font-medium leading-relaxed">{item.desc}</div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="pt-3 border-t border-stone-100 flex gap-3">
                                    <button 
                                        onClick={() => {
                                            setIsMoreMenuOpen(false);
                                            handleLogout();
                                        }}
                                        className="flex-1 py-3 bg-stone-100 hover:bg-rose-50 hover:text-rose-600 text-stone-600 rounded-2xl font-bold text-xs transition-colors flex items-center justify-center gap-2 active:scale-95">
                                        <span>🚪</span> התנתקות מהחשבון
                                    </button>
                                    <button 
                                        onClick={() => setIsMoreMenuOpen(false)}
                                        className="flex-1 py-3 bg-stone-800 hover:bg-stone-900 text-white rounded-2xl font-bold text-xs transition-colors active:scale-95">
                                        סגירה
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                </div>
            );
        }


        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
