

const { useState, useEffect, useMemo, useRef } = React;


function App() {
            const [globalState, setGlobalState] = useState(() => {
                const saved = localStorage.getItem('studyStreakData_DB_v7');
                if (saved) {
                    try {
                        const parsed = JSON.parse(saved);
                        if (parsed && parsed.users) {
                            Object.keys(parsed.users).forEach(u => {
                                if (parsed.users[u]) {
                                    if (parsed.users[u].tasks) {
                                        parsed.users[u].tasks = parsed.users[u].tasks.map(t => {
                                            if (t.isLessonLog && t.understandingRating) {
                                                return { ...t, understandingRating: null };
                                            }
                                            return t;
                                        });
                                    }
                                    if (typeof healCompletedFromHistory === 'function') {
                                        parsed.users[u] = healCompletedFromHistory(parsed.users[u]);
                                    }
                                }
                            });
                        }
                        return parsed;
                    } catch(e) { return { users: {}, activeUser: null }; }
                }
                return { users: {}, activeUser: null };
            });
            const pendingWriteSync = useRef(0);
            const hasRemoteSynced = useRef(false);

            // Cloud Sync Status & Outbox Diagnostics State
            const [syncState, setSyncState] = useState(() => (typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'synced'));
            const [syncErrorDetails, setSyncErrorDetails] = useState('');
            const [isSyncDiagnosticsOpen, setIsSyncDiagnosticsOpen] = useState(false);
            const [editingExam, setEditingExam] = useState(null);

            // Safety snapshot backup before first remote sync session
            useEffect(() => {
                try {
                    if (globalState.activeUser && !localStorage.getItem('studyStreakData_backup_pre_sync')) {
                        localStorage.setItem('studyStreakData_backup_pre_sync', JSON.stringify(globalState));
                    }
                } catch (e) {}
            }, [globalState.activeUser]);

            useEffect(() => {
                hasRemoteSynced.current = false;
                const timeout = setTimeout(() => {
                    hasRemoteSynced.current = true;
                }, 3500);
                return () => clearTimeout(timeout);
            }, [globalState.activeUser]);


            useEffect(() => {
                localStorage.setItem('studyStreakData_DB_v7', JSON.stringify(globalState));
            }, [globalState]);


            // Live Firestore Snapshot with error diagnosis
            useEffect(() => {
                if (!globalState.activeUser || !db) {
                    if (!db) setSyncState(navigator.onLine ? 'error' : 'offline');
                    return;
                }

                const userRef = db.collection("users").doc(globalState.activeUser);
                
                const unsubscribe = userRef.onSnapshot((doc) => {
                    hasRemoteSynced.current = true;
                    setSyncState('synced');
                    setSyncErrorDetails('');
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
                    setSyncState('error');
                    const isPerm = error.code === 'permission-denied' || String(error.message).includes('permission');
                    setSyncErrorDetails(isPerm 
                        ? 'חוקי האבטחה ב-Firebase פגו (Permission Denied). לחצי לתיקון מהיר.' 
                        : (error.message || 'שגיאת התחברות לענן'));
                });

                return () => unsubscribe();
            }, [globalState.activeUser]);

            // Manual & Continuous Cloud Push for Outbox Queue
            const pushPendingSyncToCloud = async (forceUser = null) => {
                const targetUser = forceUser || globalState.activeUser;
                if (!targetUser || !db) return false;
                setSyncState('syncing');
                try {
                    const pending = typeof getPendingSync === 'function' ? getPendingSync(targetUser) : null;
                    const userToUpload = pending?.data || globalState.users[targetUser];
                    if (!userToUpload) {
                        setSyncState('synced');
                        return true;
                    }
                    const cleanData = sanitizeForFirestore(userToUpload);
                    await db.collection("users").doc(targetUser).set(cleanData, { merge: true });
                    if (typeof clearPendingSync === 'function') {
                        clearPendingSync(targetUser);
                    }
                    setSyncState('synced');
                    setSyncErrorDetails('');
                    return true;
                } catch (err) {
                    console.error("Manual push sync failed:", err);
                    setSyncState('error');
                    const isPerm = err.code === 'permission-denied' || String(err.message).includes('permission');
                    setSyncErrorDetails(isPerm 
                        ? 'חוקי האבטחה ב-Firebase פגו (Permission Denied)' 
                        : (err.message || 'שגיאה בסנכרון לענן'));
                    return false;
                }
            };

            // Continuous Background Health Check (Every 35 seconds + Focus + Online)
            useEffect(() => {
                if (!globalState.activeUser) return;

                const runHealthCheck = async () => {
                    if (!navigator.onLine) {
                        setSyncState('offline');
                        return;
                    }
                    if (!db) {
                        setSyncState('error');
                        setSyncErrorDetails('Firebase לא אותחל');
                        return;
                    }

                    // 1. Drain pending outbox changes if any
                    const pending = typeof getPendingSync === 'function' ? getPendingSync(globalState.activeUser) : null;
                    if (pending) {
                        await pushPendingSyncToCloud();
                        return;
                    }

                    // 2. Probe read permission
                    try {
                        await db.collection("users").doc(globalState.activeUser).get();
                        setSyncState(prev => prev === 'error' ? 'synced' : prev);
                        setSyncErrorDetails('');
                    } catch (err) {
                        const isPerm = err.code === 'permission-denied' || String(err.message).includes('permission');
                        setSyncState('error');
                        if (isPerm) {
                            setSyncErrorDetails('חוקי האבטחה ב-Firebase פגו (Permission Denied)');
                        }
                    }
                };

                runHealthCheck();
                const interval = setInterval(runHealthCheck, 35000);

                const onOnline = () => {
                    setSyncState('syncing');
                    runHealthCheck();
                    showToast('חיבור האינטרנט חזר! מסנכרן שינויים לענן... 🔄', 'info');
                };
                const onOffline = () => {
                    setSyncState('offline');
                };
                const onFocus = () => {
                    runHealthCheck();
                };

                window.addEventListener('online', onOnline);
                window.addEventListener('offline', onOffline);
                window.addEventListener('focus', onFocus);
                document.addEventListener('visibilitychange', onFocus);

                return () => {
                    clearInterval(interval);
                    window.removeEventListener('online', onOnline);
                    window.removeEventListener('offline', onOffline);
                    window.removeEventListener('focus', onFocus);
                    document.removeEventListener('visibilitychange', onFocus);
                };
            }, [globalState.activeUser]);

            const activeUserData = globalState.activeUser ? globalState.users[globalState.activeUser] : null;

            useEffect(() => {
                if (!activeUserData) return;
                const healed = healCompletedFromHistory(activeUserData);
                if (healed !== activeUserData) {
                    updateUserData(() => healed);
                }
            }, [globalState.activeUser]);


            const sanitizeForFirestore = (obj) => {
                if (obj === undefined) return null;
                if (obj === null || typeof obj !== 'object') return obj;
                try {
                    return JSON.parse(JSON.stringify(obj, (k, v) => (v === undefined ? null : v)));
                } catch (e) {
                    return obj;
                }
            };

            const updateUserData = (updater) => {
                setGlobalState(prev => {
                    if (!prev.activeUser) return prev;
                    const user = prev.users[prev.activeUser];
                    const updatedUser = typeof updater === 'function' ? updater(user) : { ...user, ...updater };
                    if (updatedUser === user) return prev;
                    
                    updatedUser.lastSync = Date.now();
                    pendingWriteSync.current = updatedUser.lastSync;
                    
                    if (typeof markPendingSync === 'function') {
                        markPendingSync(prev.activeUser, updatedUser);
                    }

                    if (db) {
                        setSyncState('syncing');
                        try {
                            const cleanData = sanitizeForFirestore(updatedUser);
                            db.collection("users").doc(prev.activeUser).set(cleanData, { merge: true })
                              .then(() => {
                                  setSyncState('synced');
                                  setSyncErrorDetails('');
                                  if (typeof clearPendingSync === 'function') {
                                      clearPendingSync(prev.activeUser);
                                  }
                              })
                              .catch(err => {
                                  console.error("Error saving to Firebase: ", err);
                                  setSyncState('error');
                                  const isPerm = err.code === 'permission-denied' || String(err.message).includes('permission');
                                  setSyncErrorDetails(isPerm 
                                      ? 'חוקי האבטחה ב-Firebase פגו (Permission Denied). לחצי לבדיקה.' 
                                      : (err.message || 'שגיאה בשמירה לענן'));
                              });
                        } catch (err) {
                            console.error("Firebase sync error (prevented app crash): ", err);
                            setSyncState('error');
                            setSyncErrorDetails(err.message || 'שגיאה באתחול שמירה לענן');
                        }
                    } else {
                        setSyncState(navigator.onLine ? 'error' : 'offline');
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
                let newBadges = [...(userData.badges || [])].map(b => (typeof b === 'string' ? { id: b, earnedAt: new Date().toISOString() } : b));
                let earnedNew = false;
                
                const hasBadge = (id) => newBadges.some(b => b.id === id);
                
                // 1. מצטיינת מבחנים: 4 מבחנים מעל 90
                if (!hasBadge('b_exam_90')) {
                    const exams90PlusCount = (userData.exams || []).filter(e => e.grade && Number(e.grade) >= 90).length;
                    if (exams90PlusCount >= 4) {
                        newBadges.push({ id: 'b_exam_90', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('🏆 זכית בתג: מצטיינת מבחנים!', 'success');
                    }
                }
                
                // 2. טורבו: מעל 20 נקודות בשבוע
                if (!hasBadge('b_weekly_20')) {
                    if ((userData.highestWeeklyPoints || 0) >= 20 || (userData.weeklyPoints || 0) >= 20) {
                        newBadges.push({ id: 'b_weekly_20', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('⚡ זכית בתג: טורבו!', 'success');
                    }
                }
                
                // 3. חסינת איחורים: רצף של 14 ימים
                if (!hasBadge('b_on_time')) {
                    if ((userData.longestStreak || 0) >= 14 || (userData.taskStreak || 0) >= 14) {
                        newBadges.push({ id: 'b_on_time', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('⏱️ זכית בתג: חסינת איחורים!', 'success');
                    }
                }

                // 4. ספידי: הגשת 5 שיעורי בית בפחות מחצי מהזמן
                if (!hasBadge('b_fast_hw')) {
                    const fastHwCount = (userData.tasks || []).filter(t => {
                        if (!t || !t.completed || !t.completedAt || !t.createdAt || !t.dueDate) return false;
                        const cTime = new Date(t.completedAt).getTime();
                        const crTime = new Date(t.createdAt).getTime();
                        const dTime = new Date(t.dueDate + (t.dueTime ? `T${t.dueTime}` : 'T23:59:59')).getTime();
                        const totalDuration = dTime - crTime;
                        const usedDuration = cTime - crTime;
                        return totalDuration > 0 && usedDuration <= Math.max(totalDuration / 2, 86400000);
                    }).length;
                    const fastPointsCount = (userData.pointsHistory || []).filter(p => p && p.details && (p.details.includes('הוגש מוקדם') || p.points >= 2)).length;
                    if (Math.max(fastHwCount, fastPointsCount) >= 5) {
                        newBadges.push({ id: 'b_fast_hw', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('💨 זכית בתג: ספידי!', 'success');
                    }
                }

                // 5. קאמבק של אלופות: איבדת רצף, ולא נשברת - הגשת משימה ביום שאחרי
                if (!hasBadge('b_comeback')) {
                    const hasBrokenStreak = (userData.streakHistory && userData.streakHistory.length > 0) || 
                                            (userData.pointsHistory || []).some(p => p && (p.points < 0 || (p.details && p.details.includes('איחור'))));
                    const hasActiveStreakNow = (userData.taskStreak || 0) >= 1;
                    if (hasBrokenStreak && hasActiveStreakNow) {
                        newBadges.push({ id: 'b_comeback', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('🔄 זכית בתג: קאמבק של אלופות!', 'success');
                    }
                }

                // 6. שותפות לגורל: את וחברה השלמתן משימה באותו יום
                if (!hasBadge('b_sync_study')) {
                    let friendsArr = [];
                    try {
                        if (typeof liveFriends !== 'undefined' && liveFriends) {
                            friendsArr = Object.values(liveFriends);
                        }
                    } catch (e) {}
                    const userCompletedDates = (userData.tasks || [])
                        .filter(t => t && t.completed && t.completedAt)
                        .map(t => new Date(t.completedAt).toDateString());
                    
                    let hasSync = false;
                    for (const friend of friendsArr) {
                        const friendTasks = friend.tasks || [];
                        for (const ft of friendTasks) {
                            if (ft && ft.completed && ft.completedAt) {
                                const fDate = new Date(ft.completedAt).toDateString();
                                if (userCompletedDates.includes(fDate)) {
                                    hasSync = true;
                                    break;
                                }
                            }
                        }
                        if (hasSync) break;
                    }
                    if (hasSync) {
                        newBadges.push({ id: 'b_sync_study', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('🤝 זכית בתג: שותפות לגורל!', 'success');
                    }
                }

                // 7. עקיפה בסיבוב: עקפת חברה בנקודות ביום שישי לקראת סגירת השבוע
                if (!hasBadge('b_sprint')) {
                    let friendsArr = [];
                    try {
                        if (typeof liveFriends !== 'undefined' && liveFriends) {
                            friendsArr = Object.values(liveFriends);
                        }
                    } catch (e) {}
                    const isFriday = new Date().getDay() === 5;
                    const earnedOnFriday = (userData.pointsHistory || []).some(p => p && p.points > 0 && new Date(p.date).getDay() === 5);
                    const userPts = userData.weeklyPoints || 0;
                    const hasMorePointsThanFriend = friendsArr.some(f => userPts > (f.weeklyPoints || 0) && userPts > 0);
                    if ((isFriday || earnedOnFriday) && hasMorePointsThanFriend) {
                        newBadges.push({ id: 'b_sprint', earnedAt: new Date().toISOString() });
                        earnedNew = true;
                        showToast('🏎️ זכית בתג: עקיפה בסיבוב!', 'success');
                    }
                }

                if (earnedNew) {
                    return { ...userData, badges: newBadges };
                }
                return userData;
            };

            // Continuous badge check on data updates
            useEffect(() => {
                if (!activeUserData || !globalState.activeUser) return;
                const checked = checkAndAwardBadges(activeUserData);
                if (checked && checked !== activeUserData && checked.badges?.length !== (activeUserData.badges || []).length) {
                    updateUserData(() => checked);
                }
            }, [
                globalState.activeUser, 
                activeUserData?.weeklyPoints, 
                activeUserData?.taskStreak, 
                activeUserData?.longestStreak, 
                (activeUserData?.tasks || []).length, 
                (activeUserData?.exams || []).length
            ]);


            useEffect(() => {
                if (!activeUserData || !globalState.activeUser) return;
                const now = new Date().getTime();
                const weekStart = typeof getLastSaturday22PM === 'function' ? getLastSaturday22PM(now) : (now - (7 * 86400000));
                
                // 1. Regular weekly reset on Saturday 22:00
                if (now > (activeUserData.nextWeeklyReset || 0)) {
                    const userWeeklyPts = activeUserData.weeklyPoints || 0;
                    const friendsArr = Object.values(liveFriends || {});
                    let isTop = true;
                    let topFriendName = '';
                    let topFriendPts = 0;

                    friendsArr.forEach(f => {
                        const fPts = f.weeklyPoints || 0;
                        if (fPts > userWeeklyPts) {
                            isTop = false;
                            if (fPts > topFriendPts) {
                                topFriendPts = fPts;
                                topFriendName = f.name || f.username;
                            }
                        }
                    });

                    let updatedBadges = [...(activeUserData.badges || [])].map(b => (typeof b === 'string' ? { id: b, earnedAt: new Date().toISOString() } : b));
                    let wonCrown = false;

                    if (isTop && userWeeklyPts > 0) {
                        wonCrown = true;
                        const champBadgeIdx = updatedBadges.findIndex(b => b.id === 'b_weekly_champ');
                        if (champBadgeIdx !== -1) {
                            updatedBadges[champBadgeIdx] = {
                                ...updatedBadges[champBadgeIdx],
                                count: (updatedBadges[champBadgeIdx].count || 1) + 1,
                                lastWonAt: new Date().toISOString()
                            };
                        } else {
                            updatedBadges.push({
                                id: 'b_weekly_champ',
                                count: 1,
                                earnedAt: new Date().toISOString()
                            });
                        }
                        showToast(`👑 מזל טוב! הוכתרת לאלופת השבוע עם ${userWeeklyPts} נקודות! זכית בתג אלופת השבוע! 👑`, 'success');
                    } else if (topFriendName && topFriendPts > 0) {
                        showToast(`סיום שבוע! אלופת השבוע החולף היא ${topFriendName} עם ${topFriendPts} נק' 👑`, 'info');
                    }

                    updateUserData(prev => ({
                        ...prev,
                        highestWeeklyPoints: Math.max(prev.highestWeeklyPoints || 0, prev.weeklyPoints || 0),
                        lastWeekPoints: prev.weeklyPoints || 0,
                        weeklyPoints: 0,
                        nextWeeklyReset: getNextSaturday22PM(),
                        badges: wonCrown ? updatedBadges : (prev.badges || [])
                    }));
                    return;
                }

                // 2. Self-healing check: if weeklyPoints > 0 but user has not done any tasks or earned points since the start of this week, heal to 0
                if ((activeUserData.weeklyPoints || 0) > 0) {
                    const tasks = activeUserData.tasks || [];
                    const hist = activeUserData.pointsHistory || [];
                    const hasPositiveActivityThisWeek = tasks.some(t => {
                        if (!t || !t.completed || !t.completedAt) return false;
                        const tTime = new Date(t.completedAt).getTime();
                        return !isNaN(tTime) && tTime >= weekStart;
                    }) || hist.some(h => {
                        if (!h || !h.date || h.canceled || (h.points || 0) <= 0) return false;
                        const hTime = new Date(h.date).getTime();
                        return !isNaN(hTime) && hTime >= weekStart;
                    });

                    if (!hasPositiveActivityThisWeek) {
                        updateUserData(prev => ({
                            ...prev,
                            weeklyPoints: 0
                        }));
                    }
                }
            }, [globalState.activeUser, activeUserData?.nextWeeklyReset, activeUserData?.weeklyPoints]);


            useEffect(() => {
                if (!globalState.activeUser) return;
                // Guard: Wait for initial remote Firestore sync when online so stale localStorage doesn't trigger false penalties
                if (!hasRemoteSynced.current && typeof navigator !== 'undefined' && navigator.onLine !== false) return;

                updateUserData(prev => {
                    if (!prev || !prev.tasks) return prev;
                    const healedPrev = typeof healCompletedFromHistory === 'function' ? healCompletedFromHistory(prev) : prev;
                    const now = new Date();
                    let shouldBreakStreak = false;
                    let oldestUncompletedDate = null;
                    let oldestUncompletedTaskId = null;
                    let needsUpdate = false;
                    let pointsToDeduct = 0;
                    let historyLogs = [];
                    const GRACE_PERIOD_MS = 5 * 60 * 1000;

                    const updatedTasks = (healedPrev.tasks || []).map(task => {
                        const isDone = task.completed || !!task.completedAt || !!task.givenUp || (typeof taskLooksCompleted === 'function' && taskLooksCompleted(task, healedPrev.pointsHistory));
                        if (isDone) {
                            const onTime = typeof isTaskSubmittedOnTime === 'function'
                                ? isTaskSubmittedOnTime(task)
                                : (task.completedAt && task.dueDate && new Date(task.completedAt).getTime() <= (new Date(`${task.dueDate}T${task.dueTime || '23:59:59'}`).getTime() + GRACE_PERIOD_MS));
                            if (onTime && task.autoPenaltyApplied) {
                                return { ...task, completed: true, autoPenaltyApplied: false };
                            }
                            return task.completed ? task : { ...task, completed: true };
                        }
                        if (task.isLessonLog || !task.dueDate || task.isFlexibleExamSession) return task;
                        const timeStr = task.dueTime || '23:59:59';
                        const dueDate = new Date(`${task.dueDate}T${timeStr}`);
                        if (isNaN(dueDate.getTime())) return task;

                        const streakStartMs = healedPrev.currentStreakStart ? new Date(healedPrev.currentStreakStart).getTime() : 0;
                        const isTaskRelevantForStreak = !streakStartMs || dueDate.getTime() >= (streakStartMs - 86400000);

                        if (isTaskRelevantForStreak && now.getTime() > (dueDate.getTime() + GRACE_PERIOD_MS) && (healedPrev.taskStreak || 0) > 0) {
                            shouldBreakStreak = true;
                            if (!oldestUncompletedDate || dueDate < oldestUncompletedDate) {
                                oldestUncompletedDate = dueDate;
                                oldestUncompletedTaskId = task.id;
                            }
                        }
                        const hoursLate = (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60);
                        // Only apply auto-penalty to recent overdue tasks (within 72 hours), never retroactively on ancient backlog
                        if (hoursLate >= 3 && hoursLate <= 72 && !task.autoPenaltyApplied) {
                            needsUpdate = true;
                            pointsToDeduct += 2;
                            const sub = (healedPrev.subjects || []).find(s => s.id === task.subjectId);
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

                    const healedChanged = healedPrev !== prev;
                    if (!shouldBreakStreak && !needsUpdate && !healedChanged) return prev;

                    let newStreakHistory = [...(healedPrev.streakHistory || [])];
                    let taskStreak = healedPrev.taskStreak;
                    let currentStreakStart = healedPrev.currentStreakStart;
                    let currentStreakEmojis = healedPrev.currentStreakEmojis;

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
                        ...healedPrev,
                        tasks: updatedTasks,
                        totalPoints: (healedPrev.totalPoints || 0) - pointsToDeduct,
                        weeklyPoints: (healedPrev.weeklyPoints || 0) - pointsToDeduct,
                        pointsHistory: [...historyLogs, ...(healedPrev.pointsHistory || [])],
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
                    if (!t.completed && !t.completedAt) return false;
                    const dateStr = t.completedAt || (t.completed ? (t.dueDate || t.createdAt) : null);
                    if (!dateStr) return false;
                    const d = new Date(dateStr);
                    return !isNaN(d.getTime()) && d >= startOfWeek && d <= endOfWeek;
                }).map(t => {
                    const sub = (activeUserData.subjects || []).find(s => 
                        s.id === t.subjectId || 
                        s.name === t.subjectId || 
                        cleanSubjectName(s.name) === cleanSubjectName(t.subjectName || t.subject)
                    );
                    return {
                        ...t,
                        subjectName: sub ? sub.name : (t.subjectName || t.subject || 'כללי')
                    };
                });

                const completedHW = thisWeekTasks.filter(t => !t.givenUp && !t.isExamPrep && !t.isLessonLog);
                const givenUpHW = thisWeekTasks.filter(t => t.givenUp);
                const examPrepDone = thisWeekTasks.filter(t => !t.givenUp && t.isExamPrep);
                const lessonsLogged = thisWeekTasks.filter(t => t.isLessonLog);

                const thisWeekExams = (activeUserData.exams || []).filter(e => {
                    const d = new Date(e.date);
                    return !isNaN(d.getTime()) && d >= startOfWeek && d <= endOfWeek;
                });

                const thisWeekHistory = (activeUserData.pointsHistory || []).filter(h => {
                    const d = new Date(h.date);
                    return !isNaN(d.getTime()) && d >= startOfWeek && d <= endOfWeek;
                });

                const historySum = thisWeekHistory.filter(h => h.points > 0).reduce((acc, h) => acc + h.points, 0);
                const totalPointsGained = Math.max(activeUserData.weeklyPoints || 0, historySum);
                const currentStreak = activeUserData.taskStreak !== undefined ? activeUserData.taskStreak : (activeUserData.streak || 0);

                const weekTasksWithHours = thisWeekTasks.filter(t => !t.givenUp && t.studyDurationHours);
                const totalStudyHoursNum = weekTasksWithHours.reduce((sum, t) => sum + Number(t.studyDurationHours), 0);
                const totalStudyHours = totalStudyHoursNum > 0 ? parseFloat(totalStudyHoursNum.toFixed(1)) : 0;

                return {
                    startDate: startOfWeek.toLocaleDateString('he-IL'),
                    endDate: endOfWeek.toLocaleDateString('he-IL'),
                    completedHW,
                    givenUpHW,
                    examPrepDone,
                    lessonsLogged,
                    thisWeekExams,
                    totalPointsGained,
                    totalStudyHours,
                    currentStreak,
                    subjects: activeUserData.subjects || []
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
                            const lastGlobalSent = activeUserData.lastGlobalWhatsAppReminderSent || 0;
                            const hoursSinceGlobal = (Date.now() - lastGlobalSent) / (1000 * 60 * 60);

                            // מרווח גלובלי של 3.5 שעות לפחות בין תזכורות כדי למנוע ספאם!
                            if (hoursSinceGlobal >= 3.5) {
                                const activeTasks = (activeUserData.tasks || []).filter(t => !t.completed && t.whatsappRemindersEnabled && t.dueDate);
                                if (activeTasks.length > 0) {
                                    // מייצרים הודעה אחת מרוכזת ומעודנת במקום להציף בהודעות נפרדות
                                    const reminderMsg = WhatsAppService.generateCombinedStudentReminderText(
                                        activeUserData.name || 'שלי',
                                        activeTasks,
                                        activeUserData.subjects || []
                                    );

                                    WhatsAppService.sendMessage({
                                        to: activeUserData.phoneNumber,
                                        message: reminderMsg,
                                        gatewayConfig: activeUserData.whatsappGateway
                                    }).then(res => {
                                        if (res && res.status === 'sent_gateway') {
                                            updateUserData(prev => ({
                                                ...prev,
                                                lastGlobalWhatsAppReminderSent: Date.now()
                                            }));
                                        }
                                    }).catch(e => console.error('Automated WhatsApp reminder error:', e));
                                }
                            }
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
                if (activeUserData?.friends?.length > 0 && typeof db !== 'undefined' && db) {
                    const unsubscribes = [];
                    const friendUsernames = [...new Set(activeUserData.friends.map(f => f && f.username).filter(Boolean))];
                    
                    friendUsernames.forEach(username => {
                        try {
                            const unsub = db.collection("users").doc(username).onSnapshot(doc => {
                                if (doc.exists) {
                                    setLiveFriends(prev => ({
                                        ...prev, 
                                        [username]: { ...doc.data(), username: username }
                                    }));
                                }
                            }, err => {
                                console.warn(`Error listening to friend @${username}:`, err);
                            });
                            unsubscribes.push(unsub);
                        } catch (e) { console.error(e); }
                    });
                    
                    return () => { unsubscribes.forEach(u => u && u()); };
                }
            }, [activeUserData?.friends ? activeUserData.friends.map(f => f && f.username).sort().join(',') : '']);


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
                examGrade: false, quickExam: false, edit: false, reminderMode: false, notificationHelp: false,
                singleExamSession: false
            });


            const [activeTask, setActiveTask] = useState(null);
            const [taskActionsMenu, setTaskActionsMenu] = useState(null);
            const [examActionsMenu, setExamActionsMenu] = useState(null);
            const [selectedTaskForReminder, setSelectedTaskForReminder] = useState(null);
            const [selectedReminderWindow, setSelectedReminderWindow] = useState(null);
            const [reminderTemplateId, setReminderTemplateId] = useState('friendly');
            const [customReminderPhone, setCustomReminderPhone] = useState('');
            const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
            const [editingTask, setEditingTask] = useState(null);
            const [taskToCancel, setTaskToCancel] = useState(null);
            const [taskToGiveUp, setTaskToGiveUp] = useState(null);
            const [activeExamForGrade, setActiveExamForGrade] = useState(null);
            const [viewingAttachment, setViewingAttachment] = useState(null);
            const [taskFormAttachments, setTaskFormAttachments] = useState([]);
            const [editTaskAttachments, setEditTaskAttachments] = useState([]);
            const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
            const [examPrintModal, setExamPrintModal] = useState(null);
            const [isPreparingPrint, setIsPreparingPrint] = useState(false);
            const [singleExamSessionData, setSingleExamSessionData] = useState({
                examId: '',
                customExamName: '',
                customSubjectId: '',
                title: ''
            });

            useEffect(() => {
                if (editingTask) {
                    setEditTaskAttachments(editingTask.attachments || []);
                } else {
                    setEditTaskAttachments([]);
                }
            }, [editingTask]);

            const handleFilesSelected = async (e, target = 'new', category = 'general') => {
                const files = Array.from(e.target.files || []);
                if (files.length === 0) return;
                setIsUploadingAttachment(true);
                try {
                    showToast(`מעבד ${files.length} קבצים באיכות גבוהה... ⏳`, 'info');
                    const processedList = await window.FileStorage.processAndSaveFiles(files, category);
                    if (processedList && processedList.length > 0) {
                        if (target === 'new') {
                            setTaskFormAttachments(prev => [...prev, ...processedList]);
                        } else if (target === 'edit') {
                            setEditTaskAttachments(prev => [...prev, ...processedList]);
                        }
                        const label = category === 'board' ? 'צילומי לוח' : (category === 'homework' ? 'דפי עבודה' : 'קבצים');
                        showToast(`התווספו ${processedList.length} ${label} בהצלחה! 📎`, 'success');
                    }
                } catch (err) {
                    console.error('File process error:', err);
                    showToast('שגיאה בעיבוד הקובץ: ' + (err.message || err), 'error');
                } finally {
                    setIsUploadingAttachment(false);
                    e.target.value = '';
                }
            };

            const handleQuickAddAttachmentsToTask = async (task, files, category = 'general') => {
                const fileList = Array.isArray(files) ? files : Array.from(files || []);
                if (!task || fileList.length === 0) return;
                setIsUploadingAttachment(true);
                try {
                    showToast(`מעבד ${fileList.length} קבצים באיכות חדה... ⏳`, 'info');
                    const savedList = await window.FileStorage.processAndSaveFiles(fileList, category);
                    if (savedList && savedList.length > 0) {
                        updateUserData(prev => ({
                            ...prev,
                            tasks: (prev.tasks || []).map(t => {
                                if (t.id !== task.id) return t;
                                return {
                                    ...t,
                                    attachments: [...(t.attachments || []), ...savedList]
                                };
                            })
                        }));
                        const label = category === 'board' ? 'צילומי לוח' : (category === 'homework' ? 'דפי עבודה' : 'קבצים');
                        showToast(`${savedList.length} ${label} צורפו בהצלחה! 📎`, 'success');
                    }
                } catch (err) {
                    console.error('Quick attachment batch error:', err);
                    showToast('שגיאה בצירוף הקבצים: ' + (err.message || err), 'error');
                } finally {
                    setIsUploadingAttachment(false);
                }
            };

            const handleQuickAddAttachmentToTask = (task, file, category) => {
                return handleQuickAddAttachmentsToTask(task, file ? [file] : [], category);
            };

            const openAttachmentViewer = async (task, initialIndex = 0, filterCategory = null) => {
                let attachments = task.attachments || [];
                if (attachments.length === 0) return;
                if (filterCategory) {
                    const filtered = attachments.filter(a => {
                        if (filterCategory === 'board') return a.category === 'board' || (!a.category && task.isLessonLog);
                        if (filterCategory === 'homework') return a.category === 'homework' || (!a.category && !task.isLessonLog);
                        return true;
                    });
                    if (filtered.length > 0) {
                        attachments = filtered;
                    }
                }
                const activeIndex = Math.min(initialIndex, attachments.length - 1);
                const currentAtt = attachments[activeIndex];
                setViewingAttachment({
                    task,
                    attachments,
                    activeIndex,
                    currentDataUrl: null,
                    pdfPages: [],
                    loading: true
                });
                const dataUrl = await window.FileStorage.loadAttachmentData(currentAtt);
                let pdfPages = [];
                const isPdf = currentAtt && ((currentAtt.type && /pdf/i.test(currentAtt.type)) || (currentAtt.name && /\.pdf$/i.test(currentAtt.name.trim())) || (dataUrl && /data:application\/(x-)?pdf/i.test(dataUrl)));
                if (isPdf && dataUrl && window.FileStorage && window.FileStorage.renderPdfToImages) {
                    try {
                        pdfPages = await window.FileStorage.renderPdfToImages(dataUrl);
                    } catch(e) {}
                }
                setViewingAttachment(prev => prev ? {
                    ...prev,
                    currentDataUrl: dataUrl,
                    pdfPages,
                    loading: false
                } : null);
            };

            const switchAttachmentIndex = async (newIndex) => {
                if (!viewingAttachment || !viewingAttachment.attachments[newIndex]) return;
                const nextAtt = viewingAttachment.attachments[newIndex];
                setViewingAttachment(prev => ({ ...prev, activeIndex: newIndex, currentDataUrl: null, pdfPages: [], loading: true }));
                const dataUrl = await window.FileStorage.loadAttachmentData(nextAtt);
                let pdfPages = [];
                const isPdf = nextAtt && ((nextAtt.type && /pdf/i.test(nextAtt.type)) || (nextAtt.name && /\.pdf$/i.test(nextAtt.name.trim())) || (dataUrl && /data:application\/(x-)?pdf/i.test(dataUrl)));
                if (isPdf && dataUrl && window.FileStorage && window.FileStorage.renderPdfToImages) {
                    try {
                        pdfPages = await window.FileStorage.renderPdfToImages(dataUrl);
                    } catch(e) {}
                }
                setViewingAttachment(prev => prev ? { ...prev, currentDataUrl: dataUrl, pdfPages, loading: false } : null);
            };
            const [activeFriend, setActiveFriend] = useState(null);
            const [editingSubject, setEditingSubject] = useState(null);
            const [tempRules, setTempRules] = useState([]);
            
            const [selectedSettingsDay, setSelectedSettingsDay] = useState(0);
            const [activeDayIndex, setActiveDayIndex] = useState(0);


            const [archiveFilter, setArchiveFilter] = useState('all');
            const [lessonLogFilter, setLessonLogFilter] = useState('all');
            const [taskFilter, setTaskFilter] = useState('all'); 
            const [examViewTab, setExamViewTab] = useState('upcoming');
            const [pastExamSubjectFilter, setPastExamSubjectFilter] = useState('all'); 


            const [taskFormHasHW, setTaskFormHasHW] = useState(true);
            const [taskGivenDate, setTaskGivenDate] = useState(() => new Date().toISOString().split('T')[0]);
            const [lateReason, setLateReason] = useState('');
            const [otherLateReason, setOtherLateReason] = useState('');
            const [studyTimeMode, setStudyTimeMode] = useState('direct'); // 'direct' | 'range'
            const [studyDurationHoursInput, setStudyDurationHoursInput] = useState('');
            const [studyTimeStart, setStudyTimeStart] = useState('');
            const [studyTimeEnd, setStudyTimeEnd] = useState('');
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
                step: 1, subjectId: '', examName: '', date: '', time: '', hours: 5, targetSessions: 3, sessions: [], remainingMinutes: 0, existingExamId: '' 
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


            // Admin Panel State & Helpers
            const [isAdminLoggedIn, setIsAdminLoggedIn] = useState(false);
            const [adminUsersList, setAdminUsersList] = useState([]);
            const [adminLoading, setAdminLoading] = useState(false);
            const [selectedAdminUser, setSelectedAdminUser] = useState(null);
            const [deleteConfirmUser, setDeleteConfirmUser] = useState(null);
            const [deleteConfirmStep, setDeleteConfirmStep] = useState(0);
            const [adminSearch, setAdminSearch] = useState('');
            const [adminInspectorTab, setAdminInspectorTab] = useState('points');
            const [adminStreakInput, setAdminStreakInput] = useState('');
            const [adminPointsInput, setAdminPointsInput] = useState('');
            const [adminWeeklyPointsInput, setAdminWeeklyPointsInput] = useState('');

            const loadAdminUsers = async () => {
                setAdminLoading(true);
                try {
                    let map = {};
                    if (globalState?.users) {
                        Object.entries(globalState.users).forEach(([uName, uData]) => {
                            if (uName && uData) map[uName] = { ...uData, username: uName };
                        });
                    }
                    if (db) {
                        const snap = await db.collection("users").get();
                        snap.forEach(doc => {
                            const data = doc.data();
                            if (data && doc.id) {
                                map[doc.id] = { ...data, username: doc.id };
                            }
                        });
                    }
                    setAdminUsersList(Object.values(map));
                } catch(err) {
                    console.error("Error loading admin users:", err);
                    showToast('שגיאה בטעינת המשתמשים', 'error');
                } finally {
                    setAdminLoading(false);
                }
            };

            const saveAdminUserUpdate = async (username, updatedFields) => {
                if (!username) return;
                try {
                    const fieldsWithSync = {
                        ...updatedFields,
                        lastSync: Date.now()
                    };
                    if (db) {
                        await db.collection("users").doc(username).set(fieldsWithSync, { merge: true });
                    }
                    setGlobalState(prev => {
                        const existing = prev.users[username] || {};
                        return {
                            ...prev,
                            users: {
                                ...prev.users,
                                [username]: { ...existing, ...fieldsWithSync }
                            }
                        };
                    });
                    setAdminUsersList(prev => prev.map(u => u.username === username ? { ...u, ...fieldsWithSync } : u));
                    setSelectedAdminUser(prev => prev && prev.username === username ? { ...prev, ...fieldsWithSync } : prev);
                    showToast(`השינויים נשמרו בהצלחה עבור @${username} ✨`, 'success');
                } catch(err) {
                    console.error("Error updating user from admin:", err);
                    showToast('שגיאה בשמירת הנתונים', 'error');
                }
            };

            // Real-time listener for Admin panel to ensure God Mode data is always 100% in sync without flickering
            useEffect(() => {
                if (!isAdminLoggedIn || !db) return;
                const unsub = db.collection("users").onSnapshot((snapshot) => {
                    const map = {};
                    snapshot.forEach(doc => {
                        const data = doc.data();
                        if (data && doc.id) {
                            map[doc.id] = { ...data, username: doc.id };
                        }
                    });
                    setAdminUsersList(Object.values(map));
                    setSelectedAdminUser(prev => prev ? (map[prev.username] || prev) : null);
                }, (err) => {
                    console.warn("Admin live sync listener error:", err);
                });
                return () => unsub();
            }, [isAdminLoggedIn]);

            const adminToggleBadge = (user, badgeId) => {
                if (!user || !badgeId) return;
                let currentBadges = Array.isArray(user.badges) ? [...user.badges] : [];
                const idx = currentBadges.findIndex(b => (typeof b === 'string' ? b === badgeId : b?.id === badgeId));
                let newBadges;
                if (idx !== -1) {
                    newBadges = currentBadges.filter((_, i) => i !== idx);
                    showToast(`התג הוסר מחשבונה של @${user.username}`, 'info');
                } else {
                    newBadges = [...currentBadges, { id: badgeId, earnedAt: new Date().toISOString() }];
                    showToast(`התג הוענק בהצלחה ל-@${user.username}! 🏅`, 'success');
                }
                saveAdminUserUpdate(user.username, { badges: newBadges });
            };

            const adminDeleteUser = async (username) => {
                if (!username) return;
                try {
                    if (db) {
                        await db.collection("users").doc(username).delete();
                    }
                    setGlobalState(prev => {
                        const nextUsers = { ...prev.users };
                        delete nextUsers[username];
                        return {
                            ...prev,
                            users: nextUsers,
                            activeUser: prev.activeUser === username ? null : prev.activeUser
                        };
                    });
                    setAdminUsersList(prev => prev.filter(u => u.username !== username));
                    setDeleteConfirmUser(null);
                    setDeleteConfirmStep(0);
                    if (selectedAdminUser?.username === username) setSelectedAdminUser(null);
                    showToast(`החשבון של @${username} נמחק בהצלחה לצמיתות 🗑️`, 'info');
                } catch(err) {
                    console.error("Error deleting user:", err);
                    showToast('שגיאה במחיקת החשבון', 'error');
                }
            };

            const adminCancelPenalty = (user, penaltyLog) => {
                if (!user || !penaltyLog) return;
                const deducted = Math.abs(penaltyLog.points || 0);
                // החזר כפול (פי 2): החזרת הנקודות שקוזזו בקנס + הענקת נקודות ההגשה שהיו מגיעות
                const refund = deducted * 2;
                const newTotal = (user.totalPoints || 0) + refund;
                const newWeekly = (user.weeklyPoints || 0) + refund;
                const refundEntry = {
                    id: 'ph_admin_refund_' + Date.now(),
                    taskId: penaltyLog.taskId || '',
                    taskTitle: penaltyLog.taskTitle || 'ביטול קנס והחזר כפול',
                    points: refund,
                    date: new Date().toISOString(),
                    details: `ביטול קנס (${deducted} נק') והחזרת נקודות הגשה שהיו מגיעות (${deducted} נק') - סה"כ פי 2 (+${refund} נק')`
                };
                const newHistory = (user.pointsHistory || []).map(h => h.id === penaltyLog.id ? { ...h, canceled: true } : h);
                newHistory.unshift(refundEntry);
                saveAdminUserUpdate(user.username, {
                    totalPoints: newTotal,
                    weeklyPoints: newWeekly,
                    pointsHistory: newHistory
                });
                showToast(`הקנס בוטל והוחזרו פי 2 נקודות (+${refund} נקודות) לחשבון! 💚`, 'success');
            };

            const adminRestoreStreak = (user, streakItem) => {
                if (!user || !streakItem) return;
                const restoredLen = streakItem.length || 1;
                const newStreakHistory = (user.streakHistory || []).filter(s => s.id !== streakItem.id);
                saveAdminUserUpdate(user.username, {
                    taskStreak: restoredLen,
                    longestStreak: Math.max(user.longestStreak || 0, restoredLen),
                    streakHistory: newStreakHistory
                });
                showToast(`הרצף שוחזר בהצלחה ל-${restoredLen} 🔥`, 'success');
            };

            const adminSetCustomStreak = (user, count) => {
                const val = parseInt(count, 10);
                if (isNaN(val) || val < 0) {
                    showToast('נא להזין מספר רצף תקין', 'warning');
                    return;
                }
                saveAdminUserUpdate(user.username, {
                    taskStreak: val,
                    longestStreak: Math.max(user.longestStreak || 0, val)
                });
            };

            const adminSetCustomPoints = (user, totalPts, weeklyPts) => {
                const t = parseInt(totalPts, 10);
                const w = parseInt(weeklyPts, 10);
                saveAdminUserUpdate(user.username, {
                    totalPoints: isNaN(t) ? (user.totalPoints || 0) : t,
                    weeklyPoints: isNaN(w) ? (user.weeklyPoints || 0) : w
                });
            };

            const adminDeleteTask = (user, taskId) => {
                const newTasks = (user.tasks || []).filter(t => t.id !== taskId);
                saveAdminUserUpdate(user.username, { tasks: newTasks });
                showToast('המשימה נמחקה בהצלחה', 'info');
            };

            const adminToggleTask = (user, taskId) => {
                const newTasks = (user.tasks || []).map(t => {
                    if (t.id === taskId) {
                        const nowDone = !t.completed;
                        return {
                            ...t,
                            completed: nowDone,
                            completedAt: nowDone ? new Date().toISOString() : null,
                            autoPenaltyApplied: false
                        };
                    }
                    return t;
                });
                saveAdminUserUpdate(user.username, { tasks: newTasks });
            };

            const adminResetTaskPenalty = (user, taskId) => {
                const targetTask = (user.tasks || []).find(t => t.id === taskId);
                const newTasks = (user.tasks || []).map(t => t.id === taskId ? { ...t, autoPenaltyApplied: false } : t);
                
                let newHistory = [...(user.pointsHistory || [])];
                const matchingPenalty = newHistory.find(h => h.taskId === taskId && (h.points || 0) < 0 && !h.canceled);
                const deducted = matchingPenalty ? Math.abs(matchingPenalty.points) : 2;
                // החזר פי 2: החזרת הקנס שירד + נקודות ההגשה שמגיעות לה
                const refund = deducted * 2;
                
                if (matchingPenalty) {
                    matchingPenalty.canceled = true;
                }
                
                const refundEntry = {
                    id: 'ph_admin_refund_' + Date.now(),
                    taskId: taskId,
                    taskTitle: targetTask?.title || matchingPenalty?.taskTitle || 'ביטול קנס משימה',
                    points: refund,
                    date: new Date().toISOString(),
                    details: `ביטול קנס משימה והחזר נקודות הגשה כפולות (+${refund} נק') ע״י מנהל`
                };
                newHistory.unshift(refundEntry);

                const newTotal = (user.totalPoints || 0) + refund;
                const newWeekly = (user.weeklyPoints || 0) + refund;

                saveAdminUserUpdate(user.username, { 
                    tasks: newTasks,
                    totalPoints: newTotal,
                    weeklyPoints: newWeekly,
                    pointsHistory: newHistory
                });
                showToast(`בוטל קנס המשימה והוחזרו פי 2 נקודות (+${refund} נק') לחשבון! 💚`, 'success');
            };

            const showToast = (text, type = 'info') => {
                setToastMessage({ text, type });
                setTimeout(() => setToastMessage(null), 4000);
            };


            const toggleModal = (modalName, val) => setModals(m => ({ ...m, [modalName]: val }));


            const handleLogin = (e) => {
                e.preventDefault();
                const user = (e.target.username.value || '').trim();
                const pass = (e.target.password.value || '').trim();
                if(!user) return;

                // Admin check - only accessible with credentials: 'admin' or 'אדמין'
                const cleanUser = user.toLowerCase();
                const cleanPass = pass.toLowerCase();
                const isAdmin = (cleanUser === 'admin' || cleanUser === 'אדמין') && 
                                (cleanPass === 'admin' || cleanPass === 'אדמין');
                if (isAdmin) {
                    setIsAdminLoggedIn(true);
                    loadAdminUsers();
                    showToast('ברוך הבא למצב ניהול מערכת (God Mode) 🛡️', 'success');
                    return;
                }


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
                const attachments = taskData.attachments || taskFormAttachments || [];
                
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
                        givenDate: actualGivenDate,
                        attachments: attachments
                    };
                    
                    updateUserData(prev => checkAndAwardBadges({ 
                        ...prev, 
                        tasks: [noHwTask, ...prev.tasks]
                    }));
                    setTaskFormAttachments([]);
                    toggleModal('task', false);
                    showToast('השיעור תועד בהצלחה ביומן! ✨', 'success');
                } else {
                    const newTask = {
                        ...taskData,
                        id: 't_' + Date.now(),
                        createdAt: now.toISOString(),
                        completed: false,
                        givenDate: actualGivenDate,
                        autoPenaltyApplied: false,
                        attachments: attachments
                    };
                    updateUserData(prev => ({ ...prev, tasks: [newTask, ...prev.tasks] }));
                    setTaskFormAttachments([]);
                    toggleModal('task', false);
                    showToast('המשימה נוספה בהצלחה!', 'success');
                }
            };

            const calculateStudyDuration = (mode, directInput, startTime, endTime) => {
                if (mode === 'direct') {
                    const val = parseFloat(directInput);
                    if (isNaN(val) || val <= 0) return null;
                    const totalMinutes = Math.round(val * 60);
                    const hours = Math.floor(totalMinutes / 60);
                    const mins = totalMinutes % 60;
                    let formattedStr = '';
                    if (hours > 0 && mins > 0) {
                        formattedStr = `${hours} שע' ו-${mins} דק'`;
                    } else if (hours > 0) {
                        formattedStr = `${val} שעות`;
                    } else {
                        formattedStr = `${mins} דקות`;
                    }
                    return {
                        studyDurationHours: parseFloat(val.toFixed(2)),
                        studyDurationMinutes: totalMinutes,
                        studyTimeRange: formattedStr,
                        studyTimeStart: '',
                        studyTimeEnd: ''
                    };
                } else if (mode === 'range') {
                    if (!startTime || !endTime) return null;
                    const [startH, startM] = startTime.split(':').map(Number);
                    const [endH, endM] = endTime.split(':').map(Number);
                    if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return null;

                    let startTotalMins = startH * 60 + startM;
                    let endTotalMins = endH * 60 + endM;
                    if (endTotalMins < startTotalMins) {
                        endTotalMins += 24 * 60; // חציית חצות
                    }
                    const diffMins = endTotalMins - startTotalMins;
                    if (diffMins <= 0) return null;

                    const hoursExact = parseFloat((diffMins / 60).toFixed(2));
                    const hours = Math.floor(diffMins / 60);
                    const mins = diffMins % 60;
                    const durText = (hours > 0 && mins > 0)
                        ? `${hours} שע' ו-${mins} דק'`
                        : (hours > 0 ? `${hours} שעות` : `${mins} דקות`);

                    return {
                        studyDurationHours: hoursExact,
                        studyDurationMinutes: diffMins,
                        studyTimeRange: `${startTime} - ${endTime} (${durText})`,
                        studyTimeStart: startTime,
                        studyTimeEnd: endTime
                    };
                }
                return null;
            };

            const handleOpenCompleteModal = (task) => {
                setActiveTask(task);
                setLateReason('');
                setOtherLateReason('');
                setStudyTimeMode('direct');
                setStudyDurationHoursInput('');
                setStudyTimeStart('');
                setStudyTimeEnd('');
                toggleModal('complete', true);
            };

            const handleCompleteTask = (task, rating, hardExercises, chosenLateReason, durationInfo = null) => {
                const now = new Date();
                const createdAt = new Date(task.createdAt);
                let dueDate;
                
                if (task.dueDate && task.dueTime) {
                    dueDate = new Date(`${task.dueDate}T${task.dueTime}`);
                } else if (task.dueDate) {
                    dueDate = new Date(`${task.dueDate}T23:59:59`);
                } else {
                    dueDate = new Date(); 
                    dueDate.setHours(23,59,59,999);
                }


                const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                const completionTime = (task.completedAt && !isNaN(new Date(task.completedAt).getTime())) ? new Date(task.completedAt) : now;
                const totalDurationMs = dueDate.getTime() - createdAt.getTime();
                const usedDurationMs = completionTime.getTime() - createdAt.getTime();
                const GRACE_PERIOD_MS = 5 * 60 * 1000;
                const isLate = completionTime.getTime() > (dueDate.getTime() + GRACE_PERIOD_MS);
                const isSameDay = completionTime.toDateString() === dueDate.toDateString();
                
                let pointsDelta = 0;
                let pointsText = '';
                let streakBroken = false;


                if (task.rewardPoints || task.isFlexibleExamSession) {
                    pointsDelta = task.rewardPoints || 3;
                    const sessionNumStr = task.sessionNumber ? ` ${task.sessionNumber}` : '';
                    pointsText = `בוצע סשן למידה${sessionNumStr} למבחן (+${pointsDelta} נקודות)! 🎯`;
                    streakBroken = false;
                } else if (!isLate) {
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
                    details: pointsText,
                    studyDurationHours: durationInfo?.studyDurationHours || null,
                    studyTimeRange: durationInfo?.studyTimeRange || null
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

                updateUserData(prev => {
                    const updatedTasks = prev.tasks.map(t => t.id === task.id ? { 
                        ...t, completed: true, completedAt: t.completedAt || now.toISOString(), 
                        understandingRating: rating, hardExercises: hardExercises, pointsEarned: pointsDelta, lateReason: isLate ? chosenLateReason : '',
                        autoPenaltyApplied: isLate ? (t.autoPenaltyApplied || false) : false,
                        remindersEnabled: false,
                        whatsappRemindersEnabled: false,
                        studyDurationHours: durationInfo?.studyDurationHours || t.studyDurationHours || null,
                        studyDurationMinutes: durationInfo?.studyDurationMinutes || t.studyDurationMinutes || null,
                        studyTimeRange: durationInfo?.studyTimeRange || t.studyTimeRange || null,
                        studyTimeStart: durationInfo?.studyTimeStart || t.studyTimeStart || null,
                        studyTimeEnd: durationInfo?.studyTimeEnd || t.studyTimeEnd || null
                    } : t);

                    const updatedExams = (prev.exams || []).map(ex => {
                        if (task.examId && ex.id === task.examId) {
                            const completedCount = updatedTasks.filter(t => t.examId === ex.id && (t.completed || t.completedAt)).length;
                            return {
                                ...ex,
                                completedSessionsCount: completedCount,
                                sessionsCount: Math.max(ex.sessionsCount || 0, completedCount)
                            };
                        }
                        return ex;
                    });

                    return checkAndAwardBadges({
                        ...prev,
                        exams: updatedExams,
                        tasks: updatedTasks,
                        totalPoints: prev.totalPoints + pointsDelta,
                        weeklyPoints: prev.weeklyPoints + pointsDelta,
                        taskStreak: newStreak,
                        longestStreak: newLongest,
                        currentStreakStart: newStreakStart,
                        currentStreakEmojis: newStreakEmojis,
                        pointsHistory: pointsDelta !== 0 ? [historyLog, ...(prev.pointsHistory || [])] : (prev.pointsHistory || []),
                        streakHistory: newStreakHistory
                    });
                });


                toggleModal('complete', false);
                setActiveTask(null);
                setStudyDurationHoursInput('');
                setStudyTimeStart('');
                setStudyTimeEnd('');
                
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
                updateUserData(prev => {
                    const taskToDelete = (prev.tasks || []).find(t => t.id === taskId);
                    const remainingTasks = (prev.tasks || []).filter(t => t.id !== taskId);
                    let updatedExams = prev.exams;
                    if (taskToDelete && taskToDelete.examId) {
                        updatedExams = (prev.exams || []).map(ex => {
                            if (ex.id === taskToDelete.examId) {
                                const remainingForExam = remainingTasks.filter(rt => rt.examId === ex.id);
                                const completedForExam = remainingTasks.filter(rt => rt.examId === ex.id && (rt.completed || rt.completedAt)).length;
                                return {
                                    ...ex,
                                    sessionsCount: Math.max(0, remainingForExam.length),
                                    completedSessionsCount: completedForExam
                                };
                            }
                            return ex;
                        });
                    }
                    return { ...prev, tasks: remainingTasks, exams: updatedExams };
                });
                showToast('משימה נמחקה', 'success');
            };


            const handleEditTask = (e) => {
                e.preventDefault();
                if (!editingTask) return;
                const form = e.target;
                const subId = (form.elements['subId'] && form.elements['subId'].value) || editingTask.subjectId || '';
                const title = (form.elements['title'] && form.elements['title'].value) || editingTask.title || '';
                const topic = (form.elements['topic'] && form.elements['topic'].value) || '';
                const givenDate = (form.elements['givenDate'] && form.elements['givenDate'].value) || editingTask.givenDate || '';
                const newDueDate = (form.elements['date'] && form.elements['date'].value) || editingTask.dueDate || '';
                const newDueTime = (form.elements['time'] && form.elements['time'].value) || editingTask.dueTime || '';
                const startTimeInput = form.elements['startTime'];
                const newStartTime = (startTimeInput && startTimeInput.value) ? startTimeInput.value : (editingTask.startTime || null);

                const oldDue = (editingTask.dueDate && editingTask.dueTime)
                    ? new Date(`${editingTask.dueDate}T${editingTask.dueTime}`)
                    : null;
                const newDue = (newDueDate && newDueTime) ? new Date(`${newDueDate}T${newDueTime}`) : null;

                updateUserData(prev => {
                    let next = {
                        ...prev,
                        tasks: (prev.tasks || []).map(t => {
                            if (t.id !== editingTask.id) return t;
                            const updated = {
                                ...t,
                                subjectId: subId,
                                title: title,
                                lessonTopic: topic,
                                givenDate: givenDate,
                                dueDate: newDueDate || t.dueDate || '',
                                dueTime: newDueTime || t.dueTime || '',
                                attachments: editTaskAttachments || t.attachments || [],
                            };
                            if (newStartTime) {
                                updated.startTime = newStartTime;
                            } else {
                                delete updated.startTime;
                            }
                            const durInput = form.elements['studyDurationHours'];
                            if (durInput) {
                                const val = parseFloat(durInput.value);
                                if (!isNaN(val) && val > 0) {
                                    updated.studyDurationHours = parseFloat(val.toFixed(2));
                                    updated.studyDurationMinutes = Math.round(val * 60);
                                    const h = Math.floor(updated.studyDurationMinutes / 60);
                                    const m = updated.studyDurationMinutes % 60;
                                    updated.studyTimeRange = (h > 0 && m > 0) ? `${h} שע' ו-${m} דק'` : `${val} שעות`;
                                } else if (durInput.value === '') {
                                    updated.studyDurationHours = null;
                                    updated.studyDurationMinutes = null;
                                    updated.studyTimeRange = null;
                                }
                            }
                            return updated;
                        })
                    };
                    if (newDue && !isNaN(newDue.getTime())) {
                        next = restoreOnDueEdit(next, editingTask.id, oldDue, newDue, new Date());
                    }
                    return next;
                });
                toggleModal('edit', false);
                setEditingTask(null);
                setEditTaskAttachments([]);
                showToast('המשימה עודכנה בהצלחה! ✨', 'success');
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
                    const currentSubjects = prev.subjects || [];
                    const exists = subToSave.id ? currentSubjects.find(s => s.id === subToSave.id) : null;
                    if (exists) {
                        return { ...prev, subjects: currentSubjects.map(s => s.id === subToSave.id ? { ...s, ...subToSave } : s) };
                    } else {
                        return { ...prev, subjects: [...currentSubjects, { ...subToSave, id: subToSave.id || ('s_' + Date.now()) }] };
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


            const handleAddFriend = async (e) => {
                e.preventDefault();
                const rawInput = (e.target.username.value || '').trim();
                const cleanInput = rawInput.replace(/^@+/, '').trim();
                if (!cleanInput) return;

                if (cleanInput.toLowerCase() === (globalState.activeUser || '').toLowerCase()) {
                    showToast('אי אפשר להוסיף את עצמך 😅', 'warning');
                    return;
                }
                
                if ((activeUserData.friends || []).some(f => f && f.username && f.username.toLowerCase() === cleanInput.toLowerCase())) {
                    showToast('המשתמש/ת כבר ברשימת החברות שלך!', 'warning');
                    return;
                }

                if (typeof db !== 'undefined' && db) {
                    try {
                        let targetDoc = null;
                        const directDoc = await db.collection("users").doc(cleanInput).get();
                        if (directDoc.exists) {
                            targetDoc = directDoc;
                        } else {
                            // Case-insensitive lookup fallback
                            const allUsersSnap = await db.collection("users").get();
                            allUsersSnap.forEach(d => {
                                if (d.id && d.id.toLowerCase() === cleanInput.toLowerCase()) {
                                    targetDoc = d;
                                }
                            });
                        }

                        if (targetDoc && targetDoc.exists) {
                            const targetUsername = targetDoc.id;
                            const friendData = targetDoc.data();
                            const newFriend = {
                                id: 'f_' + Date.now(),
                                username: targetUsername,
                                name: friendData.name || targetUsername
                            };
                            
                            // 1. Add friend to active user's friends list
                            updateUserData(prev => ({ ...prev, friends: [...(prev.friends || []), newFriend] }));
                            toggleModal('addFriend', false);
                            showToast(`איזה כיף! ${friendData.name || targetUsername} התווסף/ה לרשימה ✨`, 'success');
                            
                            // 2. Immediately populate liveFriends with fresh data
                            setLiveFriends(prev => ({...prev, [targetUsername]: { ...friendData, username: targetUsername }}));

                            // 3. Mutual friendship: automatically add active user to friend's friends list too!
                            try {
                                const friendExistingFriends = Array.isArray(friendData.friends) ? friendData.friends : [];
                                if (!friendExistingFriends.some(f => f && f.username && f.username.toLowerCase() === (globalState.activeUser || '').toLowerCase())) {
                                    const reciprocalFriend = {
                                        id: 'f_' + Date.now() + '_recip',
                                        username: globalState.activeUser,
                                        name: activeUserData.name || globalState.activeUser
                                    };
                                    await db.collection("users").doc(targetUsername).update({
                                        friends: [...friendExistingFriends, reciprocalFriend],
                                        lastSync: Date.now()
                                    });
                                }
                            } catch (mutualErr) {
                                console.warn("Could not auto-add reciprocal friend:", mutualErr);
                            }
                        } else {
                            showToast('לא קיים משתמש עם השם הזה במערכת 😢', 'error');
                        }
                    } catch (err) {
                        console.error("Error adding friend:", err);
                        showToast('שגיאה בתקשורת עם השרת', 'error');
                    }
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

            const handleCopyFriendTask = (friendTask, friendSubNameHint) => {
                if (!friendTask) return;
                
                let rawSubName = friendSubNameHint || '';
                if (!rawSubName) {
                    const liveData = activeFriend ? (liveFriends[activeFriend.username] || {}) : {};
                    const friendSubs = liveData.subjects || activeFriend?.subjects || [];
                    const fs = friendSubs.find(s => s.id === friendTask.subjectId || s.name === friendTask.subjectId);
                    rawSubName = fs ? fs.name : (friendTask.subjectName || '');
                }

                const cleanFriend = cleanSubjectName(rawSubName);
                if (!cleanFriend) {
                    showToast('לא ניתן להעתיק: המשימה של החברה אינה משויכת למקצוע מזוהה ⚠️', 'warning');
                    return;
                }

                // Strictly compare subject names WITHOUT emojis
                const matchingSub = (activeUserData.subjects || []).find(s => cleanSubjectName(s.name) === cleanFriend);
                if (!matchingSub) {
                    showToast(`לא ניתן להעתיק: המקצוע "${rawSubName}" אינו קיים ברשימת המקצועות שלך. נא להוסיף תחילה את המקצוע אצלך ⚠️`, 'warning');
                    return;
                }

                const newTask = {
                    id: 't_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                    subjectId: matchingSub.id,
                    subjectName: matchingSub.name,
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
                showToast(`המשימה "${friendTask.title}" הועתקה בהצלחה למקצוע ${matchingSub.emoji || ''} ${matchingSub.name}! 💕`, 'success');
            };


            const handleGenerateExam = (subjectId) => {
                if (!subjectId) {
                    showToast('יש לבחור מקצוע מהרשימה', 'warning');
                    return;
                }
                setExamPrintModal({
                    subjectId,
                    mode: 'regular'
                });
            };

            const prepareAndPrintExam = async (subjectId, mode = 'regular') => {
                if (!subjectId) {
                    showToast('יש לבחור מקצוע מהרשימה', 'warning');
                    return;
                }
                setIsPreparingPrint(true);
                try {
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

                    // All tasks and lesson logs belonging to this subject
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
                    const homeworkTasks = allSubTasks.filter(t => !t.isLessonLog || (t.attachments && t.attachments.some(a => a.category === 'homework'))).sort((a, b) => {
                        const dateA = a.dueDate || a.givenDate || a.createdAt || '';
                        const dateB = b.dueDate || b.givenDate || b.createdAt || '';
                        return dateB.localeCompare(dateA);
                    });

                    // 3. All lesson log tasks in this subject
                    const lessonTasks = allSubTasks.filter(t => t.isLessonLog || (t.lessonTopic && t.lessonTopic.trim() !== '')).sort((a, b) => {
                        const dateA = a.givenDate || a.createdAt || '';
                        const dateB = b.givenDate || b.createdAt || '';
                        return dateB.localeCompare(dateA);
                    });

                    const needLessonBoard = mode === 'all' || mode === 'lessons';

                    // Load board attachments (photos) only if needed
                    const enrichedLessons = await Promise.all(lessonTasks.map(async (task) => {
                        if (!needLessonBoard) {
                            return { ...task, loadedBoardAttachments: [] };
                        }
                        const boardAtts = (task.attachments || []).filter(a => a.category === 'board' || (!a.category && task.isLessonLog));
                        if (boardAtts.length === 0) {
                            return { ...task, loadedBoardAttachments: [] };
                        }
                        const loaded = await Promise.all(boardAtts.map(async (att) => {
                            try {
                                let dataUrl = att.dataUrl;
                                if (!dataUrl && window.FileStorage && window.FileStorage.loadAttachmentData) {
                                    dataUrl = await window.FileStorage.loadAttachmentData(att);
                                }
                                return { ...att, dataUrl: dataUrl || att.dataUrl };
                            } catch (e) {
                                console.warn('Could not load board photo for print:', att.name, e);
                                return att;
                            }
                        }));
                        return { ...task, loadedBoardAttachments: loaded };
                    }));

                    // 4. Weaknesses and difficulties (understanding <= 3)
                    const weakTasks = homeworkTasks.filter(t => t.completed && t.understandingRating && Number(t.understandingRating) <= 3);

                    // 5. Hard exercises recorded
                    const hardEx = allSubTasks.filter(t => t.hardExercises && t.hardExercises.trim() !== '').map(t => ({
                        title: t.title,
                        ex: t.hardExercises,
                        date: t.completedAt || t.dueDate || t.createdAt,
                        topic: t.lessonTopic || t.title
                    }));

                    // 6. Given up tasks
                    const givenUpTasks = allSubTasks.filter(t => t.givenUp);

                    // 7. Previous exams in this subject
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

                    const printModeConfig = {
                        mode,
                        needLessonBoard,
                        includeSummary: mode === 'all' || mode === 'regular',
                        includeSyllabus: mode === 'all' || mode === 'regular',
                        includeLessonBoard: true,
                        includeHomework: mode === 'all' || mode === 'regular',
                        includeWeaknesses: mode === 'all' || mode === 'regular',
                        includeExams: mode === 'all' || mode === 'regular',
                        includeChecklist: mode === 'all' || mode === 'regular'
                    };

                    setExamPlanData({
                        subjectId: subjectIdTarget,
                        subjectName,
                        subObj,
                        allTopicsList,
                        homeworkTasks,
                        lessonTasks: enrichedLessons,
                        weakTasks,
                        hardEx,
                        givenUpTasks,
                        subjectExams,
                        examAvg,
                        avgUnderstanding,
                        completedHwCount,
                        printModeConfig,
                        date: new Date().toLocaleDateString('he-IL')
                    });

                    setExamPrintModal(null);
                    setPrintType('exam');
                    setPrintMode(true);

                    // Wait for React to render #print-area and all images to load before calling window.print()
                    setTimeout(async () => {
                        try {
                            const printArea = document.getElementById('print-area');
                            if (printArea) {
                                const imgs = Array.from(printArea.querySelectorAll('img'));
                                await Promise.all(imgs.map(img => {
                                    if (img.complete && img.naturalHeight !== 0) return Promise.resolve();
                                    return new Promise(resolve => {
                                        img.onload = () => resolve();
                                        img.onerror = () => resolve();
                                        setTimeout(resolve, 2500);
                                    });
                                }));
                            }
                        } catch(e) {}

                        // Small buffer to guarantee layout paint
                        setTimeout(() => {
                            window.print();
                            setPrintMode(false);
                            setPrintType(null);
                        }, 300);
                    }, 400);
                } catch (err) {
                    console.error('Error preparing print:', err);
                    showToast('אירעה שגיאה בהכנת מסמך ההדפסה', 'error');
                } finally {
                    setIsPreparingPrint(false);
                }
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
                
                updateUserData(prev => {
                    let completedTasksCount = 0;
                    let remainingTasks = prev.tasks || [];
                    
                    if (reuseId) {
                        // Count completed tasks for this exam to preserve streak/points/session numbering
                        completedTasksCount = (prev.tasks || []).filter(t => 
                            (t.examId === reuseId || (t.isExamPrep && t.lessonTopic && t.lessonTopic.includes(examTitle))) && 
                            (t.completed || t.completedAt)
                        ).length;

                        // Remove old uncompleted tasks for this exam so old dates and times don't remain
                        remainingTasks = (prev.tasks || []).filter(t => 
                            !( (t.examId === reuseId || (t.isExamPrep && t.lessonTopic && t.lessonTopic.includes(examTitle))) && 
                               !t.completed && !t.completedAt )
                        );
                    }

                    const newTasks = examPlannerData.sessions.map((ses, idx) => {
                        const sessionIdx = completedTasksCount + idx + 1;
                        const totalSessions = completedTasksCount + examPlannerData.sessions.length;
                        return {
                            id: 't_' + Date.now() + '_' + idx,
                            examId: examId,
                            subjectId: examPlannerData.subjectId,
                            title: `למידה ל${examTitle} ב${sub?.name || 'כללי'} (מפגש ${sessionIdx}/${totalSessions})`,
                            lessonTopic: `הכנה למבחן: ${examTitle}`,
                            createdAt: new Date().toISOString(),
                            completed: false,
                            isLessonLog: false,
                            isExamPrep: true,
                            sessionNumber: sessionIdx,
                            givenDate: new Date().toISOString().split('T')[0],
                            dueDate: ses.date,
                            startTime: ses.startTime,
                            dueTime: ses.endTime,
                            autoPenaltyApplied: false
                        };
                    });

                    const exams = [...(prev.exams || [])];
                    if (reuseId) {
                        return {
                            ...prev,
                            tasks: [...remainingTasks, ...newTasks],
                            exams: exams.map(ex => ex.id === reuseId ? {
                                ...ex,
                                examName: examTitle,
                                subjectId: examPlannerData.subjectId,
                                date: examPlannerData.date,
                                time: examPlannerData.time || ex.time || '',
                                sessionsCount: completedTasksCount + newTasks.length,
                                completedSessionsCount: completedTasksCount,
                                targetHours: examPlannerData.hours,
                                updatedAt: Date.now()
                            } : ex)
                        };
                    }
                    return {
                        ...prev,
                        tasks: [...prev.tasks, ...newTasks],
                        exams: [...exams, { 
                            id: examId, 
                            examName: examTitle, 
                            subjectId: examPlannerData.subjectId, 
                            date: examPlannerData.date, 
                            time: examPlannerData.time || '',
                            targetHours: examPlannerData.hours, 
                            sessionsCount: examPlannerData.sessions.length, 
                            completedSessionsCount: 0,
                            cancellations: 0 
                        }]
                    };
                });

                toggleModal('examPlanner', false);
                showToast(`שובצו ${examPlannerData.sessions.length} מפגשי למידה בהצלחה! תוכלי לראות אותם במשימות. 🧠`, 'success');
                setExamPlannerData({ step: 1, subjectId: '', examName: '', date: '', time: '', hours: 5, targetSessions: 3, sessions: [], remainingMinutes: 0, existingExamId: '' });
            };


            const handleAddQuickExam = (e) => {
                e.preventDefault();
                const subjectId = e.target.subjectId.value;
                const examName = e.target.examName.value;
                const date = e.target.date.value;
                const time = e.target.time?.value || '';
                
                const newExam = {
                    id: 'ex_' + Date.now(),
                    subjectId,
                    examName,
                    date,
                    time,
                    targetHours: 0,
                    sessionsCount: 0,
                    completedSessionsCount: 0,
                    cancellations: 0
                };
                
                updateUserData(prev => ({
                    ...prev,
                    exams: [...(prev.exams || []), newExam]
                }));
                
                toggleModal('quickExam', false);
                showToast('המבחן נוסף למערכת בהצלחה! 🎉', 'success');
            };

            const getNextSessionNumberForExam = (examId, tasks = activeUserData.tasks) => {
                if (!examId) return 1;
                const examTasks = (tasks || []).filter(t => t.examId === examId);
                if (examTasks.length === 0) return 1;

                let maxNum = 0;
                examTasks.forEach(t => {
                    if (typeof t.sessionNumber === 'number' && t.sessionNumber > maxNum) {
                        maxNum = t.sessionNumber;
                    }
                    const match = (t.title || '').match(/סשן\s*(\d+)/) || (t.title || '').match(/מפגש\s*(\d+)/);
                    if (match && match[1]) {
                        const parsed = parseInt(match[1], 10);
                        if (!isNaN(parsed) && parsed > maxNum) {
                            maxNum = parsed;
                        }
                    }
                });

                if (maxNum > 0) {
                    return maxNum + 1;
                }
                return examTasks.length + 1;
            };

            const handleOpenSingleSessionModal = (exam = null) => {
                const availableExams = activeUserData.exams || [];
                const targetExam = exam || (availableExams.length > 0 ? availableExams[0] : null);
                const nextNum = targetExam ? getNextSessionNumberForExam(targetExam.id, activeUserData.tasks) : 1;
                const defaultTitle = targetExam 
                    ? `ללמוד למבחן: ${targetExam.examName || 'מבחן'} - סשן ${nextNum}` 
                    : `ללמוד למבחן - סשן 1`;
                
                setSingleExamSessionData({
                    examId: targetExam ? targetExam.id : '',
                    customExamName: '',
                    customSubjectId: targetExam ? targetExam.subjectId : (activeUserData.subjects?.[0]?.id || ''),
                    title: defaultTitle
                });
                toggleModal('singleExamSession', true);
            };

            const handleCreateSingleExamSession = (e) => {
                e.preventDefault();
                const todayStr = new Date().toISOString().split('T')[0];
                const { examId, customExamName, customSubjectId, title } = singleExamSessionData;
                
                const selectedExam = (activeUserData.exams || []).find(ex => ex.id === examId);
                const examTitle = selectedExam ? (selectedExam.examName || 'מבחן') : (customExamName.trim() || 'מבחן');
                const subjectId = selectedExam ? selectedExam.subjectId : (customSubjectId || activeUserData.subjects?.[0]?.id || '');
                
                const nextNum = selectedExam ? getNextSessionNumberForExam(selectedExam.id, activeUserData.tasks) : 1;
                let sessionTitle = (title || '').trim();
                if (!sessionTitle) {
                    sessionTitle = selectedExam 
                        ? `ללמוד למבחן: ${examTitle} - סשן ${nextNum}` 
                        : `ללמוד למבחן - סשן 1`;
                }

                // Study session can be done anytime until midnight (00:00 / 23:59) before the exam
                let sessionDueDate = todayStr;
                if (selectedExam && selectedExam.date) {
                    const parts = selectedExam.date.split('-');
                    if (parts.length === 3) {
                        const year = parseInt(parts[0], 10);
                        const month = parseInt(parts[1], 10) - 1;
                        const day = parseInt(parts[2], 10);
                        const examDateObj = new Date(year, month, day);
                        examDateObj.setDate(examDateObj.getDate() - 1);
                        const y = examDateObj.getFullYear();
                        const m = String(examDateObj.getMonth() + 1).padStart(2, '0');
                        const d = String(examDateObj.getDate()).padStart(2, '0');
                        const eveDate = `${y}-${m}-${d}`;
                        sessionDueDate = eveDate >= todayStr ? eveDate : selectedExam.date;
                    }
                }

                const newSingleTask = {
                    id: 't_' + Date.now(),
                    examId: selectedExam ? selectedExam.id : null,
                    subjectId: subjectId,
                    title: sessionTitle,
                    lessonTopic: `הכנה למבחן: ${examTitle}`,
                    createdAt: new Date().toISOString(),
                    completed: false,
                    isLessonLog: false,
                    isExamPrep: true,
                    isFlexibleExamSession: true,
                    sessionNumber: nextNum,
                    rewardPoints: 3,
                    givenDate: todayStr,
                    dueDate: sessionDueDate,
                    startTime: '',
                    dueTime: '23:59',
                    autoPenaltyApplied: false
                };

                updateUserData(prev => {
                    const exams = [...(prev.exams || [])];
                    if (selectedExam) {
                        const existingExamTasks = (prev.tasks || []).filter(t => t.examId === selectedExam.id);
                        return {
                            ...prev,
                            tasks: [newSingleTask, ...(prev.tasks || [])],
                            exams: exams.map(ex => ex.id === selectedExam.id ? {
                                ...ex,
                                sessionsCount: Math.max(ex.sessionsCount || 0, existingExamTasks.length + 1)
                            } : ex)
                        };
                    }
                    return {
                        ...prev,
                        tasks: [newSingleTask, ...(prev.tasks || [])]
                    };
                });

                toggleModal('singleExamSession', false);
                showToast(`סשן ${nextNum} נוצר בהצלחה! 3 נקודות יוענקו בסיומו 🎯`, 'success');
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

            const handleToggleArchiveExam = (examId, shouldArchive) => {
                updateUserData(prev => ({
                    ...prev,
                    exams: (prev.exams || []).map(e => e.id === examId ? { ...e, isArchived: shouldArchive } : e)
                }));
                showToast(shouldArchive ? 'המבחן הועבר לארכיון בהצלחה 📦' : 'המבחן הוחזר למבחנים קרובים 🗓️', 'success');
            };

            const handleSaveEditedExam = (updatedFields) => {
                if (!editingExam) return;
                const examId = editingExam.id;

                let updatedCount = 0;
                updateUserData(prev => {
                    const originalExam = (prev.exams || []).find(ex => String(ex.id) === String(examId));
                    const oldExamName = (originalExam?.examName || editingExam.originalExamName || editingExam.examName || '').trim();
                    const oldExamDate = originalExam?.date || editingExam.originalDate || editingExam.date;
                    const oldExamTime = originalExam?.time || editingExam.originalTime || editingExam.time || '';
                    const oldSubjectId = originalExam?.subjectId || editingExam.originalSubjectId || editingExam.subjectId;

                    const newTitle = (updatedFields.examName || '').trim() || oldExamName || 'מבחן';
                    const newDate = updatedFields.date || oldExamDate;
                    const newTime = updatedFields.time !== undefined ? updatedFields.time : (editingExam.time || oldExamTime || '');
                    const newSubjectId = updatedFields.subjectId || oldSubjectId;

                    const updatedExams = (prev.exams || []).map(ex => {
                        if (String(ex.id) !== String(examId)) return ex;
                        return {
                            ...ex,
                            ...updatedFields,
                            examName: newTitle,
                            date: newDate,
                            time: newTime,
                            subjectId: newSubjectId,
                            updatedAt: Date.now()
                        };
                    });

                    const syncResult = syncExamStudyTasks(
                        examId,
                        newDate,
                        newTitle,
                        newSubjectId,
                        prev.tasks || [],
                        prev.scheduleSettings || [],
                        { oldName: oldExamName, oldDate: oldExamDate, newTime: newTime }
                    );
                    updatedCount = syncResult.updatedCount;

                    return {
                        ...prev,
                        exams: updatedExams,
                        tasks: syncResult.updatedTasks
                    };
                });

                setEditingExam(null);
                if (updatedCount > 0) {
                    showToast(`פרטי המבחן ו-${updatedCount} מפגשי למידה עודכנו וסונכרנו בהצלחה! 🎯`, 'success');
                } else {
                    showToast('פרטי המבחן עודכנו בהצלחה! ✏️', 'success');
                }
            };

            const handleResyncExamStudySessions = (exam) => {
                if (!exam) return;
                let syncCount = 0;
                updateUserData(prev => {
                    const syncResult = syncExamStudyTasks(
                        exam.id,
                        exam.date,
                        exam.examName,
                        exam.subjectId,
                        prev.tasks || [],
                        prev.scheduleSettings || [],
                        { oldName: exam.examName, oldDate: exam.date, newTime: exam.time, forceRecalculate: true }
                    );
                    syncCount = syncResult.updatedCount;
                    return {
                        ...prev,
                        tasks: syncResult.updatedTasks
                    };
                });
                if (syncCount > 0) {
                    showToast(`שעות ותאריכי הלמידה ל-${exam.examName || 'מבחן'} רועננו וסונכרנו בהצלחה (${syncCount} מפגשים)! 🎯`, 'success');
                } else {
                    showToast(`כל מפגשי הלמידה ל-${exam.examName || 'מבחן'} כבר מסונכרנים ללו״ז! ✨`, 'info');
                }
            };

            const handleAddExamToCalendar = (exam) => {
                const sub = activeUserData.subjects.find(s => s.id === exam.subjectId);
                const subjectName = sub ? sub.name : 'כללי';
                const title = `מבחן: ${exam.examName || 'מבחן'} ב${subjectName}`;
                
                const dueDate = new Date(exam.date);
                if (exam.time) {
                    const [h, m] = exam.time.split(':');
                    dueDate.setHours(parseInt(h, 10) || 8, parseInt(m, 10) || 0, 0);
                } else {
                    dueDate.setHours(8, 0, 0);
                }


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
                        lessonTasks = [],
                        homeworkTasksEnriched = [],
                        weakTasks = [],
                        hardEx = [],
                        givenUpTasks = [],
                        subjectExams = [],
                        examAvg,
                        avgUnderstanding,
                        completedHwCount = 0,
                        printModeConfig = {},
                        date
                    } = examPlanData;

                    return (
                        <div id="print-area" className="bg-white text-black p-8 font-sans text-right" dir="rtl">
                            {/* Header */}
                            <div className="text-center mb-6 border-b-2 border-stone-800 pb-4">
                                <div className="flex items-center justify-between text-xs text-stone-500 font-bold mb-2">
                                    <span className="bg-purple-50 text-purple-900 px-2.5 py-1 rounded-lg border border-purple-200">StudyStreak Pro • שנת לימודים תשפ"ו</span>
                                    <span>תאריך הפקה: {date}</span>
                                </div>
                                <h1 className="text-2xl md:text-3xl font-black text-stone-900 mb-1">
                                    {printModeConfig?.mode === 'lessons' ? `📸 יומן שיעורים וצילומי לוח: ${subjectName}` :
                                     printModeConfig?.mode === 'regular' ? `📝 חוברת סיכום והכנה לבחינה: ${subjectName}` :
                                     `🌟 חוברת הכנה מקיפה למבחן: ${subjectName}`}
                                </h1>
                                <p className="text-sm font-bold text-stone-600">
                                    תלמידה: {activeUserData.name} • {
                                        printModeConfig?.mode === 'lessons' ? 'יומן שיעורים וצילומי לוח מהכיתה' :
                                        printModeConfig?.mode === 'regular' ? 'חוברת סיכום והכנה מרוכזת (טקסט וסיכום)' :
                                        'חוברת הכנה מקיפה כולל צילומי לוח'
                                    }
                                </p>
                            </div>

                            {/* Summary KPI Cards */}
                            {printModeConfig?.includeSummary && (
                                <div className="grid grid-cols-4 gap-3 mb-6 break-inside-avoid">
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
                            )}

                            {/* Section 1: Syllabus / Lesson Topics */}
                            {printModeConfig?.includeSyllabus && (
                                <div className="mb-6 break-inside-avoid">
                                    <h2 className="text-base font-bold bg-purple-50 text-purple-900 p-2.5 mb-3 rounded-lg border border-purple-200 flex items-center justify-between">
                                        <span>📚 סילבוס ונושאי הלימוד שנלמדו ({allTopicsList.length})</span>
                                        <span className="text-xs font-normal text-purple-700">סמני V בתיבה לצד כל נושא שחזרת עליו</span>
                                    </h2>
                                    {allTopicsList.length > 0 ? (
                                        <div className="grid grid-cols-2 gap-2 text-xs">
                                            {allTopicsList.map((item, idx) => (
                                                <div key={idx} className="flex items-center justify-between p-2.5 rounded-lg border border-stone-200 bg-stone-50/60 break-inside-avoid">
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
                            )}

                            {/* Section 2: Lesson Log & Whiteboard Photos */}
                            {printModeConfig?.includeLessonBoard && (
                                <div className="mb-6">
                                    <h2 className="text-base font-bold bg-purple-50 text-purple-900 p-2.5 mb-3 rounded-lg border border-purple-200 flex items-center justify-between">
                                        <span>
                                            {printModeConfig?.needLessonBoard 
                                                ? `📸 יומן שיעורים וצילומי לוח מהכיתה (${lessonTasks.length})` 
                                                : `📖 יומן שיעורים ונושאים (${lessonTasks.length})`}
                                        </span>
                                        <span className="text-xs font-normal text-purple-700">
                                            {printModeConfig?.needLessonBoard ? 'כותרות שיעורים וצילומי הלוח' : 'כותרות השיעורים והערות'}
                                        </span>
                                    </h2>
                                    {lessonTasks.length > 0 ? (
                                        <div className="space-y-4">
                                            {lessonTasks.map((task, idx) => {
                                                const photos = task.loadedBoardAttachments || [];
                                                return (
                                                    <div key={task.id || idx} className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 break-inside-avoid">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-bold text-stone-800 text-sm">{task.lessonTopic || task.title}</span>
                                                                {task.title && task.title !== task.lessonTopic && (
                                                                    <span className="text-xs text-stone-500">({task.title})</span>
                                                                )}
                                                            </div>
                                                            <span className="text-xs text-stone-500 font-medium" dir="rtl">
                                                                {task.givenDate ? new Date(task.givenDate).toLocaleDateString('he-IL') : (task.createdAt ? new Date(task.createdAt).toLocaleDateString('he-IL') : '-')}
                                                            </span>
                                                        </div>
                                                        {task.notes && (
                                                            <p className="text-xs text-stone-700 mb-2 bg-white p-2 rounded border border-stone-100 whitespace-pre-wrap">{task.notes}</p>
                                                        )}
                                                        {printModeConfig?.needLessonBoard && photos.length > 0 && (
                                                            <div className="mt-3 space-y-3">
                                                                <div className="text-xs font-bold text-purple-900 flex items-center gap-1.5">
                                                                    <span>📸</span> צילומי לוח מהשיעור ({photos.length}):
                                                                </div>
                                                                {photos.map((p, pIdx) => {
                                                                    const isImg = p.dataUrl && (p.dataUrl.startsWith('data:image/') || p.type?.startsWith('image/'));
                                                                    if (isImg) {
                                                                        return (
                                                                            <div key={p.id || pIdx} className="border-2 border-purple-200 rounded-2xl p-4 bg-white text-center break-inside-avoid my-2 shadow-xs">
                                                                                <div className="flex items-center justify-between text-xs font-bold text-stone-700 mb-3 pb-2 border-b border-stone-200">
                                                                                    <span className="flex items-center gap-2 text-purple-950 font-black text-sm">
                                                                                        <span>📸</span> {p.name || 'צילום לוח'}
                                                                                    </span>
                                                                                    <span className="bg-purple-100 text-purple-800 px-3 py-1 rounded-full text-xs font-bold">
                                                                                        צילום לוח מהשיעור
                                                                                    </span>
                                                                                </div>
                                                                                <img 
                                                                                    src={p.dataUrl} 
                                                                                    alt={p.name || 'צילום לוח'} 
                                                                                    className="w-full max-w-4xl mx-auto object-contain rounded-lg border border-stone-200 shadow-xs" 
                                                                                />
                                                                            </div>
                                                                        );
                                                                    }
                                                                    return null;
                                                                })}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="text-stone-500 text-xs italic p-3 bg-stone-50 rounded-lg border border-stone-200">
                                            לא תועדו שיעורים למקצוע זה עדיין.
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Section 3: Homework Tasks List (no files or pdfs) */}
                            {printModeConfig?.includeHomework && (
                                <div className="mb-6">
                                    <h2 className="text-base font-bold bg-indigo-50 text-indigo-900 p-2.5 mb-3 rounded-lg border border-indigo-200 flex items-center justify-between">
                                        <span>📝 שיעורי בית ומטלות לתרגול ({homeworkTasks.length})</span>
                                        <span className="text-xs font-normal text-indigo-700">פירוט המטלות ומעקב הבנה</span>
                                    </h2>
                                    {homeworkTasks.length > 0 ? (
                                        <div className="space-y-3">
                                            {homeworkTasks.map((task, idx) => (
                                                <div key={task.id || idx} className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 break-inside-avoid">
                                                    <div className="flex items-center justify-between mb-1.5">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-bold text-stone-800 text-sm">{task.title}</span>
                                                            {task.lessonTopic && (
                                                                <span className="text-xs text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-100 font-medium">{task.lessonTopic}</span>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-2 text-xs">
                                                            <span className="text-stone-500" dir="rtl">
                                                                {task.dueDate ? `הגשה: ${new Date(task.dueDate).toLocaleDateString('he-IL')}` : ''}
                                                            </span>
                                                            {task.completed ? (
                                                                <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 text-[11px] font-bold">הוגש ✅</span>
                                                            ) : (
                                                                <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 text-[11px] font-bold">פתוח ⏳</span>
                                                            )}
                                                            {task.understandingRating && (
                                                                <span className="text-amber-800 font-bold bg-amber-100/80 px-2 py-0.5 rounded text-[11px]">הבנה: {task.understandingRating}/5</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    {task.hardExercises && (
                                                        <div className="text-xs text-rose-800 bg-rose-50 p-2 rounded border border-rose-100 mt-2">
                                                            <strong>תרגילים מאתגרים:</strong> {task.hardExercises}
                                                        </div>
                                                    )}
                                                    {task.notes && (
                                                        <p className="text-xs text-stone-600 mt-1.5 bg-white p-2 rounded border border-stone-100 whitespace-pre-wrap">{task.notes}</p>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-stone-500 text-xs italic p-3 bg-stone-50 rounded-lg border border-stone-200">
                                            לא תועדו משימות שיעורי בית למקצוע זה.
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Section 4: Weaknesses & Difficulties */}
                            {printModeConfig?.includeWeaknesses && (
                                <div className="mb-6 break-inside-avoid">
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
                            )}

                            {/* Section 5: Previous Exams & Grades */}
                            {printModeConfig?.includeExams && (
                                <div className="mb-6 break-inside-avoid">
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
                            )}

                            {/* Section 6: Exam Day Checklist */}
                            {printModeConfig?.includeChecklist && (
                                <div className="mb-6 p-3.5 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50/50 text-xs break-inside-avoid">
                                    <div className="font-bold text-stone-800 mb-2">📋 צ'ק-ליסט אישי לקראת המבחן:</div>
                                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                                        <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> חזרה על כל הגדרות ונוסחאות החומר</div>
                                        <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> פתרון חוזר של התרגילים המאתגרים</div>
                                        <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> תרגול לפחות מבחן מתכונת אחד לדוגמה</div>
                                        <div className="flex items-center gap-2"><span className="w-3.5 h-3.5 border border-stone-400 rounded bg-white inline-block"></span> שינה טובה וארוחת בוקר ביום הבחינה</div>
                                    </div>
                                </div>
                            )}

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
                            
                            <div className="grid grid-cols-4 gap-4 mb-8">
                                <div className="bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
                                    <div className="text-sm text-stone-500 font-bold mb-1 uppercase">משימות הושלמו</div>
                                    <div className="text-3xl font-black text-emerald-600">{weeklyReportData.completedHW.length}</div>
                                </div>
                                <div className="bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
                                    <div className="text-sm text-stone-500 font-bold mb-1 uppercase">שעות למידה ⏳</div>
                                    <div className="text-3xl font-black text-indigo-600">{weeklyReportData.totalStudyHours || 0}</div>
                                </div>
                                <div className="bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
                                    <div className="text-sm text-stone-500 font-bold mb-1 uppercase">סשנים למבחנים</div>
                                    <div className="text-3xl font-black text-amber-600">{weeklyReportData.examPrepDone.length}</div>
                                </div>
                                <div className="bg-stone-100 p-5 rounded-2xl text-center border border-stone-200">
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
                                            return <li key={t.id}><strong>{sub ? sub.name : 'כללי'}:</strong> {t.title} <span className="text-stone-500 text-sm font-medium mr-1">(דירוג הבנה: {t.understandingRating}/5){t.studyTimeRange ? ` • ⏳ ${t.studyTimeRange}` : ''}</span></li>
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
                        if (analyticsTimeFilter === 'last7') {
                            const sevenDaysAgo = new Date();
                            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                            return taskDate >= sevenDaysAgo;
                        }
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
                        if (analyticsTimeFilter === 'last7') {
                            const sevenDaysAgo = new Date();
                            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                            return exDate >= sevenDaysAgo;
                        }
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
                        : analyticsTimeFilter === 'last7'
                            ? 'השבוע (7 ימים אחרונים)'
                            : analyticsTimeFilter === 'last30' 
                                ? '30 ימים אחרונים' 
                                : formatMonthLabel(analyticsTimeFilter);

                    const printTasksWithHours = completedTasks.filter(t => t.studyDurationHours && !isNaN(Number(t.studyDurationHours)));
                    const printTotalStudyHoursNum = printTasksWithHours.reduce((sum, t) => sum + Number(t.studyDurationHours), 0);
                    const printTotalStudyHours = printTotalStudyHoursNum > 0 ? parseFloat(printTotalStudyHoursNum.toFixed(1)) : 0;

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

                            <div className="grid grid-cols-5 gap-2.5 mb-6">
                                <div className="bg-stone-50 p-4 rounded-xl text-center border border-stone-200">
                                    <div className="text-xs text-stone-500 font-bold mb-1 uppercase">משימות שהוגשו</div>
                                    <div className="text-2xl font-black text-purple-700">{completedTasks.length}</div>
                                </div>
                                <div className="bg-stone-50 p-4 rounded-xl text-center border border-stone-200">
                                    <div className="text-xs text-stone-500 font-bold mb-1 uppercase">שעות למידה ⏳</div>
                                    <div className="text-2xl font-black text-indigo-600">{printTotalStudyHours > 0 ? `${printTotalStudyHours} שע'` : '0'}</div>
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
                if (isAdminLoggedIn) {
                    return (
                        <div className="min-h-screen bg-stone-100 p-4 md:p-8 text-right selection:bg-purple-200" dir="rtl">
                            {toastMessage && (
                                <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[10000] px-5 py-3 rounded-2xl font-bold shadow-xl border ${
                                    toastMessage.type === 'success' ? 'bg-emerald-600 text-white border-emerald-700' :
                                    toastMessage.type === 'error' ? 'bg-rose-600 text-white border-rose-700' : 'bg-stone-900 text-white border-stone-800'
                                }`}>
                                    {toastMessage.text}
                                </div>
                            )}

                            <div className="max-w-6xl mx-auto space-y-6">
                                <div className="bg-stone-900 text-white p-6 md:p-8 rounded-3xl shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative overflow-hidden">
                                    <div className="absolute top-0 right-0 w-64 h-64 bg-purple-600/10 rounded-full blur-3xl pointer-events-none"></div>
                                    <div className="relative z-10">
                                        <div className="flex items-center gap-3">
                                            <span className="text-3xl md:text-4xl">🛡️</span>
                                            <div>
                                                <h1 className="text-2xl md:text-3xl font-black tracking-tight">מרכז ניהול מערכת (God Mode)</h1>
                                                <p className="text-stone-400 text-xs md:text-sm mt-1">צפייה בכל החשבונות, ביטול קנסות, שחזור רצפים ומחיקה מאובטחת</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2.5 flex-wrap relative z-10">
                                        <button 
                                            onClick={loadAdminUsers}
                                            className="bg-stone-800 hover:bg-stone-700 text-stone-200 px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 active:scale-95 transition-all">
                                            <span>🔄</span> רענן משתמשים
                                        </button>
                                        <button 
                                            onClick={() => { setIsAdminLoggedIn(false); setSelectedAdminUser(null); }}
                                            className="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 active:scale-95 transition-all shadow-md">
                                            <span>🚪</span> יציאה ממצב מנהל
                                        </button>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
                                    <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs text-center">
                                        <div className="text-[11px] font-bold text-stone-400 uppercase">משתמשים רשומים</div>
                                        <div className="text-3xl font-black text-stone-800 mt-1">{adminUsersList.length}</div>
                                    </div>
                                    <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs text-center">
                                        <div className="text-[11px] font-bold text-stone-400 uppercase">סה"כ נקודות</div>
                                        <div className="text-3xl font-black text-purple-600 mt-1">
                                            {adminUsersList.reduce((s, u) => s + (u.totalPoints || 0), 0)}
                                        </div>
                                    </div>
                                    <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs text-center">
                                        <div className="text-[11px] font-bold text-stone-400 uppercase">סה"כ רצפים</div>
                                        <div className="text-3xl font-black text-rose-500 mt-1">
                                            {adminUsersList.reduce((s, u) => s + (u.taskStreak || 0), 0)} 🔥
                                        </div>
                                    </div>
                                    <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs text-center">
                                        <div className="text-[11px] font-bold text-stone-400 uppercase">סה"כ משימות</div>
                                        <div className="text-3xl font-black text-blue-600 mt-1">
                                            {adminUsersList.reduce((s, u) => s + (u.tasks?.length || 0), 0)} 📋
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-white p-4 rounded-2xl border border-stone-200 shadow-xs flex items-center gap-3">
                                    <span className="text-stone-400 text-lg">🔍</span>
                                    <input 
                                        type="text" 
                                        value={adminSearch} 
                                        onChange={e => setAdminSearch(e.target.value)} 
                                        placeholder="חיפוש משתמשת לפי שם, שם משתמש או מספר טלפון..." 
                                        className="w-full bg-transparent text-sm font-bold outline-none text-stone-800 placeholder-stone-400"
                                    />
                                    {adminSearch && (
                                        <button onClick={() => setAdminSearch('')} className="text-xs font-bold text-stone-400 hover:text-stone-600">
                                            נקה
                                        </button>
                                    )}
                                </div>

                                {adminLoading ? (
                                    <div className="bg-white p-12 rounded-3xl text-center text-stone-400 font-bold border border-stone-200">
                                        טוען את רשימת החשבונות מהענן... ⏳
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {adminUsersList.filter(u => {
                                            if (!adminSearch) return true;
                                            const q = adminSearch.toLowerCase();
                                            return (u.name || '').toLowerCase().includes(q) || 
                                                   (u.username || '').toLowerCase().includes(q) ||
                                                   (u.phoneNumber || '').includes(q);
                                        }).map(u => {
                                            const pendingCount = (u.tasks || []).filter(t => !t.completed).length;
                                            const champBadge = (u.badges || []).find(b => b.id === 'b_weekly_champ');
                                            const champCount = champBadge?.count || (champBadge ? 1 : 0);

                                            return (
                                                <div key={u.username} className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm flex flex-col justify-between gap-4 hover:border-purple-300 transition-all">
                                                    <div>
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="flex items-center gap-3">
                                                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-100 to-rose-100 flex items-center justify-center font-black text-purple-700 text-lg border border-purple-200">
                                                                    {(u.name || 'א').charAt(0)}
                                                                </div>
                                                                <div>
                                                                    <div className="font-bold text-base text-stone-900 flex items-center gap-1.5 flex-wrap">
                                                                        <span>{u.name}</span>
                                                                        {champCount > 0 && (
                                                                            <span className="text-[10px] bg-amber-100 text-amber-900 px-2 py-0.5 rounded-full font-black border border-amber-300">
                                                                                👑 x{champCount}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <div className="text-xs text-stone-400 font-medium" dir="ltr">@{u.username}</div>
                                                                </div>
                                                            </div>
                                                            <div className="bg-stone-50 border border-stone-200 px-2.5 py-1 rounded-lg text-xs font-mono text-stone-600" title="סיסמת המשתמשת">
                                                                🔑 {u.password || 'ללא'}
                                                            </div>
                                                        </div>

                                                        <div className="grid grid-cols-4 gap-2 mt-4 text-center">
                                                            <div className="bg-stone-50 p-2 rounded-xl border border-stone-100">
                                                                <div className="text-[10px] text-stone-400 font-bold">רצף</div>
                                                                <div className="font-black text-rose-500 text-sm">{u.taskStreak || 0} 🔥</div>
                                                            </div>
                                                            <div className="bg-stone-50 p-2 rounded-xl border border-stone-100">
                                                                <div className="text-[10px] text-stone-400 font-bold">השבוע</div>
                                                                <div className="font-black text-purple-600 text-sm">{u.weeklyPoints || 0} ⚡</div>
                                                            </div>
                                                            <div className="bg-stone-50 p-2 rounded-xl border border-stone-100">
                                                                <div className="text-[10px] text-stone-400 font-bold">סה"כ נק'</div>
                                                                <div className="font-black text-emerald-600 text-sm">{u.totalPoints || 0}</div>
                                                            </div>
                                                            <div className="bg-stone-50 p-2 rounded-xl border border-stone-100">
                                                                <div className="text-[10px] text-stone-400 font-bold">משימות פתוחות</div>
                                                                <div className="font-black text-blue-600 text-sm">{pendingCount} 📋</div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-2 pt-3 border-t border-stone-100 flex-wrap">
                                                        <button 
                                                            onClick={() => { 
                                                                setSelectedAdminUser(u); 
                                                                setAdminStreakInput(u.taskStreak || 0);
                                                                setAdminPointsInput(u.totalPoints || 0);
                                                                setAdminWeeklyPointsInput(u.weeklyPoints || 0);
                                                            }} 
                                                            className="flex-1 bg-purple-600 hover:bg-purple-700 text-white font-bold py-2.5 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all shadow-xs">
                                                            <span>⚡</span> ניהול חשבון (God Mode)
                                                        </button>
                                                        <button 
                                                            onClick={() => { setDeleteConfirmUser(u); setDeleteConfirmStep(1); }} 
                                                            className="bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold py-2.5 px-4 rounded-xl text-xs border border-rose-200 flex items-center justify-center gap-1 active:scale-95 transition-all shrink-0"
                                                            title="מחיקת חשבון מאובטחת">
                                                            <span>🗑️</span> מחיקה מאובטחת
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {deleteConfirmUser && (
                                <div className="fixed inset-0 bg-stone-950/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
                                    <div className="bg-white rounded-3xl w-full max-w-md p-6 text-center shadow-2xl border-2 border-rose-300 animate-[fadeIn_0.2s_ease-out]">
                                        <div className="w-16 h-16 rounded-full bg-rose-100 text-rose-600 text-3xl flex items-center justify-center mx-auto mb-4">
                                            ⚠️
                                        </div>
                                        <h3 className="text-xl font-black text-stone-900 mb-2">אזהרת מחיקת חשבון</h3>
                                        <p className="text-xs text-stone-600 font-medium mb-6 leading-relaxed">
                                            את עומדת למחוק את החשבון של <strong>{deleteConfirmUser.name}</strong> (@{deleteConfirmUser.username}) לצמיתות!<br/>
                                            כל המשימות, היסטוריית הנקודות והנתונים יימחקו ללא אפשרות שחזור.
                                        </p>

                                        {deleteConfirmStep === 1 && (
                                            <div className="space-y-2">
                                                <button 
                                                    onClick={() => setDeleteConfirmStep(2)}
                                                    className="w-full py-3.5 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl text-sm shadow-md transition-all active:scale-95">
                                                    שלב 1/2: אני בטוח/ה, להמשיך למחיקה ⚠️
                                                </button>
                                                <button 
                                                    onClick={() => { setDeleteConfirmUser(null); setDeleteConfirmStep(0); }}
                                                    className="w-full py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-600 font-bold rounded-xl text-xs transition-colors">
                                                    ביטול
                                                </button>
                                            </div>
                                        )}

                                        {deleteConfirmStep === 2 && (
                                            <div className="space-y-2 animate-[fadeIn_0.2s_ease-out]">
                                                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 font-bold mb-3">
                                                    לחיצה נוספת תמחק את החשבון מיד ממסד הנתונים!
                                                </div>
                                                <button 
                                                    onClick={() => adminDeleteUser(deleteConfirmUser.username)}
                                                    className="w-full py-3.5 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-xl text-sm shadow-lg shadow-rose-600/30 transition-all active:scale-95">
                                                    שלב 2/2: אישור סופי ומוחלט - מחק חשבון לצמיתות 💥
                                                </button>
                                                <button 
                                                    onClick={() => { setDeleteConfirmUser(null); setDeleteConfirmStep(0); }}
                                                    className="w-full py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-600 font-bold rounded-xl text-xs transition-colors">
                                                    חזרה וביטול
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {selectedAdminUser && (
                                <div className="fixed inset-0 bg-stone-950/60 backdrop-blur-sm z-[999] flex items-center justify-center p-2 md:p-6 overflow-y-auto">
                                    <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl border border-stone-200 p-6 relative custom-scrollbar animate-[fadeIn_0.2s_ease-out]">
                                        <button 
                                            onClick={() => setSelectedAdminUser(null)} 
                                            className="absolute top-4 left-4 p-2 bg-stone-100 hover:bg-stone-200 rounded-full text-stone-400 active:scale-95">
                                            <IconX className="w-4 h-4"/>
                                        </button>

                                        <div className="flex items-center gap-3 mb-6">
                                            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 text-white flex items-center justify-center font-black text-2xl shadow-md">
                                                {(selectedAdminUser.name || 'א').charAt(0)}
                                            </div>
                                            <div>
                                                <h2 className="text-xl font-black text-stone-900">{selectedAdminUser.name}</h2>
                                                <div className="text-xs text-stone-400 font-medium" dir="ltr">@{selectedAdminUser.username}</div>
                                            </div>
                                        </div>

                                        <div className="flex border-b border-stone-200 mb-6 gap-2 overflow-x-auto pb-1">
                                            {[
                                                { id: 'points', label: 'נקודות וקנסות 💰' },
                                                { id: 'streaks', label: 'רצפים ושחזור 🔥' },
                                                { id: 'tasks', label: 'משימות 📋' },
                                                { id: 'badges', label: 'תגים והישגים 🏅' },
                                                { id: 'profile', label: 'פרטים אישיים 👤' }
                                            ].map(t => (
                                                <button 
                                                    key={t.id}
                                                    onClick={() => setAdminInspectorTab(t.id)}
                                                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
                                                        adminInspectorTab === t.id 
                                                            ? 'bg-purple-600 text-white shadow-sm' 
                                                            : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                                    }`}>
                                                    {t.label}
                                                </button>
                                            ))}
                                        </div>

                                        {adminInspectorTab === 'points' && (
                                            <div className="space-y-6">
                                                <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200">
                                                    <h4 className="font-bold text-sm text-stone-800 mb-3">עדכון נקודות ידני</h4>
                                                    <div className="grid grid-cols-2 gap-3 mb-3">
                                                        <div>
                                                            <label className="text-[10px] font-bold text-stone-500 uppercase block mb-1">סה"כ נקודות</label>
                                                            <input 
                                                                type="number" 
                                                                value={adminPointsInput} 
                                                                onChange={e => setAdminPointsInput(e.target.value)}
                                                                className="w-full p-2.5 bg-white border border-stone-300 rounded-xl text-sm font-bold outline-none text-center"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-[10px] font-bold text-stone-500 uppercase block mb-1">נקודות השבוע</label>
                                                            <input 
                                                                type="number" 
                                                                value={adminWeeklyPointsInput} 
                                                                onChange={e => setAdminWeeklyPointsInput(e.target.value)}
                                                                className="w-full p-2.5 bg-white border border-stone-300 rounded-xl text-sm font-bold outline-none text-center"
                                                            />
                                                        </div>
                                                    </div>
                                                    <button 
                                                        onClick={() => adminSetCustomPoints(selectedAdminUser, adminPointsInput, adminWeeklyPointsInput)}
                                                        className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2.5 rounded-xl text-xs shadow-sm active:scale-95 transition-all">
                                                        שמור שינוי נקודות 💾
                                                    </button>
                                                </div>

                                                <div>
                                                    <h4 className="font-bold text-sm text-stone-800 mb-2 flex items-center justify-between">
                                                        <span>ביטול קנסות והחזרת נקודות:</span>
                                                        <span className="text-xs text-stone-400 font-medium">לחיצה על ביטול קנס מחזירה את הנקודות מיד</span>
                                                    </h4>
                                                    {(() => {
                                                        const penalties = (selectedAdminUser.pointsHistory || []).filter(h => (h.points || 0) < 0 && !h.canceled);
                                                        if (penalties.length === 0) {
                                                            return (
                                                                <div className="text-xs text-stone-400 italic bg-stone-50 p-4 rounded-xl text-center border border-dashed border-stone-200">
                                                                    אין קנסות פעילים בהיסטוריה של המשתמשת 🎉
                                                                </div>
                                                            );
                                                        }
                                                        return (
                                                            <div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar">
                                                                {penalties.map((pen, idx) => (
                                                                    <div key={pen.id || idx} className="bg-rose-50/70 border border-rose-200 p-3 rounded-xl flex items-center justify-between gap-3">
                                                                        <div>
                                                                            <div className="font-bold text-stone-800 text-xs">{pen.details || pen.taskTitle || 'קנס איחור'}</div>
                                                                            <div className="text-[10px] text-stone-400">{new Date(pen.date).toLocaleDateString('he-IL')} • קנס של {Math.abs(pen.points)} נקודות</div>
                                                                        </div>
                                                                        <button 
                                                                            onClick={() => adminCancelPenalty(selectedAdminUser, pen)}
                                                                            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3 py-1.5 rounded-lg active:scale-95 transition-all shrink-0 shadow-xs"
                                                                            title="ביטול קנס והחזרת נקודות הגשה (פי 2)">
                                                                            בטל קנס והחזר פי 2 (+{Math.abs(pen.points) * 2} נק') 💚
                                                                        </button>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        );
                                                    })()}
                                                </div>
                                            </div>
                                        )}

                                        {adminInspectorTab === 'streaks' && (
                                            <div className="space-y-6">
                                                <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200">
                                                    <h4 className="font-bold text-sm text-stone-800 mb-2">קביעת רצף ידני</h4>
                                                    <div className="flex gap-2">
                                                        <input 
                                                            type="number" 
                                                            value={adminStreakInput} 
                                                            onChange={e => setAdminStreakInput(e.target.value)}
                                                            className="flex-1 p-2.5 bg-white border border-stone-300 rounded-xl text-sm font-bold outline-none text-center"
                                                            placeholder="מספר רצף..."
                                                        />
                                                        <button 
                                                            onClick={() => adminSetCustomStreak(selectedAdminUser, adminStreakInput)}
                                                            className="bg-rose-500 hover:bg-rose-600 text-white font-bold px-4 rounded-xl text-xs active:scale-95 transition-all">
                                                            עדכן רצף 🔥
                                                        </button>
                                                    </div>
                                                </div>

                                                <div>
                                                    <h4 className="font-bold text-sm text-stone-800 mb-2">שחזור רצפים שנשברו (היסטוריית שבירות):</h4>
                                                    {(() => {
                                                        const history = selectedAdminUser.streakHistory || [];
                                                        if (history.length === 0) {
                                                            return (
                                                                <div className="text-xs text-stone-400 italic bg-stone-50 p-4 rounded-xl text-center border border-dashed border-stone-200">
                                                                    אין רצפים שבורים בהיסטוריה
                                                                </div>
                                                            );
                                                        }
                                                        return (
                                                            <div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar">
                                                                {history.map((sh, idx) => (
                                                                    <div key={sh.id || idx} className="bg-white border border-stone-200 p-3 rounded-xl flex items-center justify-between gap-3 shadow-xs">
                                                                        <div>
                                                                            <div className="font-bold text-stone-800 text-xs">רצף של {sh.length} משימות 🔥</div>
                                                                            <div className="text-[10px] text-stone-400">
                                                                                {new Date(sh.startDate).toLocaleDateString('he-IL')} עד {new Date(sh.endDate).toLocaleDateString('he-IL')}
                                                                            </div>
                                                                        </div>
                                                                        <button 
                                                                            onClick={() => adminRestoreStreak(selectedAdminUser, sh)}
                                                                            className="bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs px-3 py-1.5 rounded-lg active:scale-95 transition-all shrink-0">
                                                                            שחזר רצף זה ({sh.length} 🔥)
                                                                        </button>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        );
                                                    })()}
                                                </div>
                                            </div>
                                        )}

                                        {adminInspectorTab === 'tasks' && (
                                            <div className="space-y-3">
                                                <h4 className="font-bold text-sm text-stone-800 mb-2">רשימת משימות ({(selectedAdminUser.tasks || []).length}):</h4>
                                                <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
                                                    {(selectedAdminUser.tasks || []).map(t => (
                                                        <div key={t.id} className="bg-stone-50 border border-stone-200 p-3 rounded-xl flex items-center justify-between gap-2">
                                                            <div className="flex-1">
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`w-2 h-2 rounded-full ${t.completed ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                                                                    <span className="font-bold text-stone-800 text-xs">{t.title}</span>
                                                                    {t.completed && <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.2 rounded font-bold">הושלם</span>}
                                                                    {t.autoPenaltyApplied && <span className="text-[10px] bg-rose-100 text-rose-700 px-1.5 py-0.2 rounded font-bold">נקנס</span>}
                                                                </div>
                                                                <div className="text-[10px] text-stone-400 mt-0.5">
                                                                    {t.dueDate ? `הגשה: ${t.dueDate} ${t.dueTime || ''}` : 'ללא תאריך הגשה'}
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 shrink-0">
                                                                <button 
                                                                    onClick={() => adminToggleTask(selectedAdminUser, t.id)}
                                                                    className="text-[11px] bg-white border border-stone-200 px-2 py-1 rounded-lg font-bold hover:bg-stone-100">
                                                                    {t.completed ? 'סמן כלא הושלם' : 'סמן כהושלם'}
                                                                </button>
                                                                {t.autoPenaltyApplied && (
                                                                    <button 
                                                                        onClick={() => adminResetTaskPenalty(selectedAdminUser, t.id)}
                                                                        className="text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-700 px-2 py-1 rounded-lg font-bold hover:bg-emerald-100"
                                                                        title="ביטול קנס והחזרת נקודות הגשה (פי 2)">
                                                                        בטל קנס (פי 2 נק') 💚
                                                                    </button>
                                                                )}
                                                                <button 
                                                                    onClick={() => adminDeleteTask(selectedAdminUser, t.id)}
                                                                    className="p-1.5 text-stone-400 hover:text-rose-600 rounded-lg"
                                                                    title="מחק משימה זו">
                                                                    <IconTrash className="w-3.5 h-3.5"/>
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {adminInspectorTab === 'badges' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center justify-between">
                                                    <h4 className="font-bold text-sm text-stone-800">ניהול תגים והישגים 🏅</h4>
                                                    <span className="text-xs text-stone-400 font-medium">הענקת תג או הסרתו בלחיצה</span>
                                                </div>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-80 overflow-y-auto custom-scrollbar">
                                                    {ALL_BADGES.map(badge => {
                                                        const userBadges = Array.isArray(selectedAdminUser.badges) ? selectedAdminUser.badges : [];
                                                        const hasIt = userBadges.some(b => (typeof b === 'string' ? b === badge.id : b?.id === badge.id));
                                                        return (
                                                            <div key={badge.id} className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 transition-all ${
                                                                hasIt ? 'bg-amber-50/80 border-amber-200' : 'bg-stone-50 border-stone-200 opacity-70'
                                                            }`}>
                                                                <div className="flex items-center gap-3">
                                                                    <span className="text-2xl">{badge.icon}</span>
                                                                    <div>
                                                                        <div className="font-bold text-xs text-stone-800 flex items-center gap-1.5">
                                                                            {badge.title}
                                                                            {hasIt && <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded-full">פעיל</span>}
                                                                        </div>
                                                                        <div className="text-[10px] text-stone-500 mt-0.5 line-clamp-1">{badge.description}</div>
                                                                    </div>
                                                                </div>
                                                                <button 
                                                                    onClick={() => adminToggleBadge(selectedAdminUser, badge.id)}
                                                                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 active:scale-95 shadow-xs ${
                                                                        hasIt 
                                                                            ? 'bg-rose-100 hover:bg-rose-200 text-rose-700' 
                                                                            : 'bg-purple-600 hover:bg-purple-700 text-white'
                                                                    }`}>
                                                                    {hasIt ? 'הסר תג ❌' : 'הענק תג ✨'}
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}

                                        {adminInspectorTab === 'profile' && (
                                            <div className="space-y-4">
                                                <div>
                                                    <label className="text-xs font-bold text-stone-500 uppercase block mb-1">שם תצוגה</label>
                                                    <input 
                                                        type="text" 
                                                        defaultValue={selectedAdminUser.name} 
                                                        id="adminEditName"
                                                        className="w-full p-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm font-bold outline-none"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-xs font-bold text-stone-500 uppercase block mb-1">סיסמה</label>
                                                    <input 
                                                        type="text" 
                                                        defaultValue={selectedAdminUser.password} 
                                                        id="adminEditPass"
                                                        className="w-full p-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm font-bold outline-none font-mono"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-xs font-bold text-stone-500 uppercase block mb-1">טלפון תלמידה</label>
                                                    <input 
                                                        type="text" 
                                                        defaultValue={selectedAdminUser.phoneNumber || ''} 
                                                        id="adminEditPhone"
                                                        className="w-full p-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm font-bold outline-none"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-xs font-bold text-stone-500 uppercase block mb-1">טלפון הורה 1</label>
                                                    <input 
                                                        type="text" 
                                                        defaultValue={selectedAdminUser.parentPhoneNumber || ''} 
                                                        id="adminEditParent1"
                                                        className="w-full p-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm font-bold outline-none"
                                                    />
                                                </div>
                                                <button 
                                                    onClick={() => {
                                                        const n = document.getElementById('adminEditName')?.value;
                                                        const p = document.getElementById('adminEditPass')?.value;
                                                        const ph = document.getElementById('adminEditPhone')?.value;
                                                        const p1 = document.getElementById('adminEditParent1')?.value;
                                                        saveAdminUserUpdate(selectedAdminUser.username, {
                                                            name: n || selectedAdminUser.name,
                                                            password: p || selectedAdminUser.password,
                                                            phoneNumber: ph,
                                                            parentPhoneNumber: p1
                                                        });
                                                    }}
                                                    className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 rounded-xl text-xs shadow-md active:scale-95 transition-all">
                                                    שמור פרטי משתמש 💾
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                }

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
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-xs text-stone-500 font-medium">היי, {activeUserData.name}</span>
                                        <button 
                                            onClick={() => setIsSyncDiagnosticsOpen(true)}
                                            className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition-all flex items-center gap-1 cursor-pointer ${
                                                syncState === 'synced' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100' :
                                                syncState === 'syncing' ? 'bg-amber-50 text-amber-700 border border-amber-200 animate-pulse' :
                                                syncState === 'offline' ? 'bg-stone-100 text-stone-600 border border-stone-200 hover:bg-stone-200' :
                                                'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
                                            }`}
                                            title="סטטוס סנכרון ענן - לחצי לבדיקה ואבחון">
                                            <span className={`w-1.5 h-1.5 rounded-full ${
                                                syncState === 'synced' ? 'bg-emerald-500' :
                                                syncState === 'syncing' ? 'bg-amber-500' :
                                                syncState === 'offline' ? 'bg-stone-400' : 'bg-rose-500'
                                            }`}></span>
                                            {syncState === 'synced' ? 'מסונכרן' :
                                             syncState === 'syncing' ? 'מסנכרן...' :
                                             syncState === 'offline' ? 'מצב מקומי' : 'שגיאת סנכרון'}
                                        </button>
                                    </div>
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
                            <button 
                                onClick={() => setIsSyncDiagnosticsOpen(true)}
                                className={`text-[10px] px-2.5 py-1.5 rounded-xl font-bold transition-all flex items-center gap-1 active:scale-95 cursor-pointer ${
                                    syncState === 'synced' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                                    syncState === 'syncing' ? 'bg-amber-50 text-amber-700 border border-amber-200 animate-pulse' :
                                    syncState === 'offline' ? 'bg-stone-100 text-stone-600 border border-stone-200' :
                                    'bg-rose-50 text-rose-700 border border-rose-200'
                                }`}
                                title="סטטוס סנכרון ענן">
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                    syncState === 'synced' ? 'bg-emerald-500' :
                                    syncState === 'syncing' ? 'bg-amber-500' :
                                    syncState === 'offline' ? 'bg-stone-400' : 'bg-rose-500'
                                }`}></span>
                                <span>{syncState === 'synced' ? 'מסונכרן' :
                                       syncState === 'syncing' ? 'מסנכרן...' :
                                       syncState === 'offline' ? 'מקומי' : 'שגיאה'}</span>
                            </button>
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
                                        {(() => {
                                            const weekHours = (activeUserData.tasks || [])
                                                .filter(t => {
                                                    if (!t.completed || !t.studyDurationHours) return false;
                                                    const d = t.completedAt ? new Date(t.completedAt) : (t.dueDate ? new Date(t.dueDate) : null);
                                                    if (!d) return false;
                                                    const sevenDaysAgo = new Date();
                                                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                                                    return d >= sevenDaysAgo;
                                                })
                                                .reduce((sum, t) => sum + Number(t.studyDurationHours), 0);
                                            return weekHours > 0 ? (
                                                <div className="text-[11px] font-bold text-indigo-600 mt-1.5 flex items-center gap-1">
                                                    <span>⏳</span> {parseFloat(weekHours.toFixed(1))} שעות למידה
                                                </div>
                                            ) : null;
                                        })()}
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
                                            .filter(t => !t.completed && !t.completedAt && !t.givenUp)
                                            .sort((a,b) => {
                                                const timeA = (a.dueDate && a.dueTime) ? new Date(`${a.dueDate}T${a.dueTime}`).getTime() : Infinity;
                                                const timeB = (b.dueDate && b.dueTime) ? new Date(`${b.dueDate}T${b.dueTime}`).getTime() : Infinity;
                                                return timeA - timeB;
                                            })
                                            .slice(0,4).map(task => {
                                            const sub = activeUserData.subjects.find(s => s.id === task.subjectId);
                                            const isTaskDone = task.completed || !!task.completedAt || !!task.givenUp;
                                            const isLate = !isTaskDone && task.dueDate && task.dueTime && new Date() > new Date(`${task.dueDate}T${task.dueTime}`);
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
                                                                {task.attachments && task.attachments.length > 0 && (
                                                                    <button 
                                                                        type="button"
                                                                        onClick={(e) => { e.stopPropagation(); openAttachmentViewer(task); }}
                                                                        className="text-[10px] font-bold text-purple-700 bg-purple-100 hover:bg-purple-200 px-2 py-0.5 rounded-lg border border-purple-200 flex items-center gap-1 shadow-xs transition-colors cursor-pointer"
                                                                        title="צפייה בצילומי לוח ודפי עבודה"
                                                                    >
                                                                        <span>📎</span> {task.attachments.length} קבצים
                                                                    </button>
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
                                                        <button onClick={() => handleOpenCompleteModal(task)} className={`flex-1 border px-4 py-3 rounded-2xl transition-all font-bold text-sm flex items-center justify-center gap-2 active:scale-95 shadow-xs ${isLate ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100' : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200'}`}>
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
                                        {activeUserData.tasks.filter(t => !t.completed && !t.completedAt && !t.givenUp).length === 0 && (
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
                                    <div className="flex items-center gap-2.5 flex-wrap">
                                        <button onClick={() => { setTaskFormHasHW(true); setTaskGivenDate(new Date().toISOString().split('T')[0]); toggleModal('task', true); }} className="bg-stone-800 text-white px-5 py-3 rounded-2xl text-sm font-bold shadow-md hover:bg-stone-900 transition-colors flex items-center justify-center gap-2 active:scale-95">
                                            <IconPlus className="w-4 h-4"/> הוספת חדש
                                        </button>
                                    </div>
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
                                        const isTaskDone = task.completed || !!task.completedAt || !!task.givenUp || (typeof taskLooksCompleted === 'function' && taskLooksCompleted(task));
                                        const isLate = !isTaskDone && task.dueDate && task.dueTime && new Date() > new Date(`${task.dueDate}T${task.dueTime}`);
                                        const onTimeSubmitted = typeof isTaskSubmittedOnTime === 'function' ? isTaskSubmittedOnTime(task) : false;
                                        return (
                                            <div key={task.id} className={`p-4 rounded-3xl border transition-all ${isTaskDone ? 'bg-stone-50/50 border-stone-200 opacity-75' : isLate ? 'bg-rose-50/30 border-rose-200' : 'bg-white border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] hover:shadow-md'}`}>
                                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                            <span className="text-xs px-2 py-1 rounded-lg font-bold shadow-sm" style={{backgroundColor: sub?.color || '#f5f5f4', color: sub ? '#fff' : '#57534e'}}>
                                                                {sub?.emoji} {sub?.name || 'כללי'}
                                                            </span>
                                                            {task.isExamPrep && (
                                                                <span className="text-[10px] font-bold text-white bg-gradient-to-r from-indigo-500 to-purple-500 px-2 py-1 rounded-lg shadow-sm flex items-center gap-1">
                                                                    <span>🎯</span> {task.sessionNumber ? `סשן למידה ${task.sessionNumber}` : 'סשן למידה'}
                                                                </span>
                                                            )}
                                                            {task.rewardPoints && (
                                                                <span className="text-[10px] font-bold text-amber-900 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-lg shadow-xs flex items-center gap-1">
                                                                    <span>⚡</span> +{task.rewardPoints} נק'
                                                                </span>
                                                            )}
                                                            {task.remindersEnabled && !isTaskDone && (
                                                                <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-lg border border-purple-200 flex items-center gap-1 shadow-xs">
                                                                    <span>🔔</span> תזכורות פעילות
                                                                </span>
                                                            )}
                                                            {task.whatsappRemindersEnabled && !isTaskDone && (
                                                                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-lg border border-emerald-200 flex items-center gap-1 shadow-xs">
                                                                    <span>💬</span> תזכורות וואטסאפ
                                                                </span>
                                                            )}
                                                            {!task.isLessonLog && !isTaskDone && task.dueDate && (() => {
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
                                                            {isTaskDone && !task.isLessonLog && !task.givenUp && (
                                                                <span className="text-xs font-medium text-stone-500 bg-white border border-stone-200 px-2 py-1 rounded-lg shadow-sm">
                                                                    הושלם ב: <span dir="ltr">{new Date(task.completedAt || Date.now()).toLocaleString('he-IL', {dateStyle: 'short', timeStyle: 'short'})}</span>
                                                                </span>
                                                            )}
                                                            {task.givenUp && (
                                                                <span className="text-xs font-bold text-white bg-stone-400 px-2 py-1 rounded-lg shadow-sm">
                                                                    🏳️ ויתרתי
                                                                </span>
                                                            )}
                                                            {task.lateReason && !task.givenUp && !onTimeSubmitted && (
                                                                <span className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded-lg border border-rose-100">
                                                                    סיבת איחור: {task.lateReason}
                                                                </span>
                                                            )}
                                                            {task.attachments && task.attachments.length > 0 && (
                                                                <button 
                                                                    type="button"
                                                                    onClick={(e) => { e.stopPropagation(); openAttachmentViewer(task); }} 
                                                                    className="text-xs font-bold text-purple-700 bg-purple-100 hover:bg-purple-200 px-2.5 py-1 rounded-lg border border-purple-200 flex items-center gap-1 shadow-xs transition-colors cursor-pointer"
                                                                    title="צפייה בצילומי לוח ודפי עבודה"
                                                                >
                                                                    <span>📎</span> {task.attachments.length} קבצים
                                                                </button>
                                                            )}
                                                        </div>
                                                        <h3 className={`font-bold text-lg ${isTaskDone ? 'line-through text-stone-400' : 'text-stone-800'}`}>{task.title}</h3>
                                                        <div className="text-sm text-stone-500 mt-1 font-medium">{task.lessonTopic && `נושא: ${task.lessonTopic}`}</div>
                                                        
                                                        {isTaskDone && !task.isLessonLog && !task.givenUp && (
                                                            <div className="mt-4 text-xs space-y-2 border-t border-stone-200/50 pt-3 flex flex-wrap gap-2">
                                                                <span className="bg-white border border-stone-200 text-stone-600 px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1 shadow-sm">
                                                                    הבנה: {task.understandingRating || 5}/5
                                                                </span>
                                                                <span className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1 shadow-sm ${(task.pointsEarned ?? 0) > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'}`}>
                                                                    {(task.pointsEarned ?? 0) > 0 ? '+'+task.pointsEarned : (task.pointsEarned ?? 0)} נק'
                                                                </span>
                                                                {task.studyTimeRange && (
                                                                    <span className="bg-indigo-50 border border-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold flex items-center gap-1 shadow-sm">
                                                                        ⏳ {task.studyTimeRange}
                                                                    </span>
                                                                )}
                                                                {task.hardExercises && <span className="text-rose-700 font-semibold bg-rose-50 px-3 py-1.5 rounded-lg border border-rose-100 shadow-sm">קשה: {task.hardExercises}</span>}
                                                            </div>
                                                        )}
                                                    </div>
                                                    
                                                    <div className="flex md:flex-col gap-2 w-full md:w-44 shrink-0 border-t md:border-t-0 md:border-r border-stone-100 pt-3 md:pt-0 md:pr-4">
                                                        {!isTaskDone ? (
                                                            <div className="flex gap-2 w-full items-center">
                                                                <button onClick={() => handleOpenCompleteModal(task)} className={`flex-1 border px-3 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-1.5 active:scale-95 shadow-xs ${isLate ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100' : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200'}`}>
                                                                    <IconCheck className="w-4 h-4 text-emerald-600"/> {isLate ? 'הגשה באיחור' : 'סיימתי!'}
                                                                </button>
                                                                <button onClick={() => setTaskActionsMenu(task)} className="px-3 py-2.5 bg-stone-50 hover:bg-stone-100 text-stone-600 border border-stone-200 rounded-xl transition-all font-bold text-sm flex items-center justify-center gap-1 active:scale-95 shadow-xs" title="אפשרויות נוספות">
                                                                    <span className="text-base font-black leading-none">⋯</span>
                                                                    <span className="text-xs">אפשרויות</span>
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex gap-2 w-full items-center">
                                                                <button onClick={() => setTaskActionsMenu(task)} className="flex-1 px-3 py-2.5 bg-stone-50 hover:bg-stone-100 text-stone-600 border border-stone-200 rounded-xl transition-all font-bold text-sm flex items-center justify-center gap-1.5 active:scale-95 shadow-xs" title="אפשרויות משימה">
                                                                    <span className="text-base font-black leading-none">⋯</span>
                                                                    <span className="text-xs">אפשרויות</span>
                                                                </button>
                                                                <button onClick={() => handleDeleteTask(task.id)} className="px-3 py-2.5 bg-stone-50 text-stone-400 border border-stone-200 rounded-xl hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors flex items-center justify-center text-sm font-medium active:scale-95" title="מחיקה מהרשימה">
                                                                    <IconTrash className="w-4 h-4"/>
                                                                </button>
                                                            </div>
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
                                        {activeUserData.subjects && activeUserData.subjects.length > 0 && (
                                            <button 
                                                onClick={() => {
                                                    const subId = lessonLogFilter !== 'all' ? lessonLogFilter : (logSubjects[0]?.id || activeUserData.subjects[0]?.id);
                                                    if (!subId) {
                                                        showToast('יש להגדיר לפחות מקצוע אחד כדי להדפיס', 'warning');
                                                        return;
                                                    }
                                                    setExamPrintModal({
                                                        subjectId: subId,
                                                        mode: 'lessons',
                                                        customSections: {
                                                            summary: false,
                                                            syllabus: false,
                                                            lessonsWithBoard: true,
                                                            homeworkWithFiles: false,
                                                            weaknesses: false,
                                                            exams: false,
                                                            checklist: false
                                                        }
                                                    });
                                                }}
                                                className="bg-purple-50 hover:bg-purple-100 text-purple-700 px-4 py-2.5 rounded-2xl text-xs font-bold border border-purple-200 shadow-xs transition-all active:scale-95 flex items-center gap-2 self-start sm:self-auto"
                                            >
                                                <span>🖨️</span> הדפסת יומן וצילומי לוח
                                            </button>
                                        )}
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
                                                            {(() => {
                                                                const allAtts = task.attachments || [];
                                                                const boardAtts = allAtts.filter(a => a.category === 'board' || (!a.category && task.isLessonLog));
                                                                const hwAtts = allAtts.filter(a => a.category === 'homework' || (!a.category && !task.isLessonLog));

                                                                return (
                                                                    <>
                                                                        {boardAtts.length > 0 && (
                                                                            <button 
                                                                                type="button"
                                                                                onClick={() => openAttachmentViewer(task, 0, 'board')} 
                                                                                className="text-xs font-bold text-purple-700 bg-purple-50 hover:bg-purple-100 px-2.5 py-1 rounded-lg border border-purple-200 flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                                                                                title="צפייה בצילומי לוח מהשיעור"
                                                                            >
                                                                                <span>📸</span> צילומי לוח ({boardAtts.length})
                                                                            </button>
                                                                        )}
                                                                        {hwAtts.length > 0 && (
                                                                            <button 
                                                                                type="button"
                                                                                onClick={() => openAttachmentViewer(task, 0, 'homework')} 
                                                                                className="text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg border border-indigo-200 flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                                                                                title="צפייה בקובצי שיעורי הבית של השיעור"
                                                                            >
                                                                                <span>📄</span> קובצי ש.ב ({hwAtts.length})
                                                                            </button>
                                                                        )}
                                                                    </>
                                                                );
                                                            })()}
                                                        </div>
                                                        <h3 className="font-bold text-lg text-stone-800">{task.lessonTopic}</h3>
                                                        {!task.isLessonLog && <div className="text-sm text-stone-500 mt-1">מתוך משימה: {task.title}</div>}
                                                    </div>
                                                    <div className="flex gap-2 shrink-0 border-t md:border-t-0 md:border-r border-stone-100 pt-3 md:pt-0 md:pr-4 items-center flex-wrap">
                                                        <label className="bg-purple-50 hover:bg-purple-100 text-purple-800 border border-purple-200 px-3 py-2 rounded-xl transition-all flex items-center justify-center gap-1.5 text-xs font-bold w-full md:w-auto active:scale-95 cursor-pointer shadow-xs" title="הוספת צילום לוח מהשיעור">
                                                            <input 
                                                                type="file" 
                                                                multiple 
                                                                accept="image/*" 
                                                                className="hidden" 
                                                                onChange={async (e) => {
                                                                    const files = Array.from(e.target.files || []);
                                                                    if (files.length === 0) return;
                                                                    await handleQuickAddAttachmentsToTask(task, files, 'board');
                                                                    e.target.value = '';
                                                                }} 
                                                            />
                                                            <span>📸</span> + צילום לוח
                                                        </label>
                                                        
                                                        {!task.isLessonLog && (
                                                            <label className="bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 px-3 py-2 rounded-xl transition-all flex items-center justify-center gap-1.5 text-xs font-bold w-full md:w-auto active:scale-95 cursor-pointer shadow-xs" title="הוספת דף עבודה או קובץ שיעורי בית">
                                                                <input 
                                                                    type="file" 
                                                                    multiple 
                                                                    accept="image/*,application/pdf" 
                                                                    className="hidden" 
                                                                    onChange={async (e) => {
                                                                        const files = Array.from(e.target.files || []);
                                                                        if (files.length === 0) return;
                                                                        await handleQuickAddAttachmentsToTask(task, files, 'homework');
                                                                        e.target.value = '';
                                                                    }} 
                                                                />
                                                                <span>📄</span> + דף ש.ב
                                                            </label>
                                                        )}

                                                        <button onClick={() => handleRemoveFromLessonLog(task.id)} className="bg-stone-50 text-stone-400 hover:text-rose-600 border border-stone-200 hover:border-rose-200 px-2.5 py-2 rounded-xl hover:bg-rose-50 transition-colors flex items-center justify-center gap-1 text-xs font-medium w-full md:w-auto active:scale-95" title="מחיקה מהיומן">
                                                            <IconTrash className="w-4 h-4"/>
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

                            const allExams = activeUserData.exams || [];
                            const todayMidnight = new Date();
                            todayMidnight.setHours(0, 0, 0, 0);

                            const isExamPast = (exam) => {
                                if (!exam || !exam.date) return false;
                                if (exam.isArchived) return true;
                                const d = new Date(exam.date);
                                d.setHours(0, 0, 0, 0);
                                return d < todayMidnight;
                            };

                            const upcomingExams = allExams
                                .filter(e => !isExamPast(e))
                                .sort((a, b) => new Date(a.date) - new Date(b.date));

                            const pastExams = allExams
                                .filter(e => isExamPast(e))
                                .sort((a, b) => new Date(b.date) - new Date(a.date));

                            const pastExamsWithGrades = pastExams.filter(e => e.grade && !isNaN(Number(e.grade)));
                            const avgPastGrade = pastExamsWithGrades.length > 0 
                                ? (pastExamsWithGrades.reduce((sum, e) => sum + Number(e.grade), 0) / pastExamsWithGrades.length).toFixed(1)
                                : null;
                            const highestPastGrade = pastExamsWithGrades.length > 0
                                ? Math.max(...pastExamsWithGrades.map(e => Number(e.grade)))
                                : null;
                            const pendingGradeCount = pastExams.filter(e => !e.grade).length;

                            const pastSubjects = [...new Set(pastExams.map(e => e.subjectId))].map(id => (activeUserData.subjects || []).find(s => s.id === id)).filter(Boolean);

                            const filteredPastExams = pastExamSubjectFilter === 'all'
                                ? pastExams
                                : pastExams.filter(e => e.subjectId === pastExamSubjectFilter);

                            return (
                            <div className="space-y-6 max-w-4xl mx-auto animate-[fadeIn_0.3s_ease-out]">
                                
                                <div className="bg-white p-6 rounded-3xl border border-stone-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] relative overflow-hidden group">
                                    <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none transition-transform group-hover:scale-110"></div>
                                    <div className="flex flex-col md:flex-row justify-between md:items-end gap-6 relative z-10">
                                        <div>
                                            <h2 className="text-2xl font-bold text-stone-800 tracking-tight flex items-center gap-2">
                                                <span>🗓️</span> ניהול והכנה למבחנים
                                            </h2>
                                            <p className="text-sm text-stone-500 mt-2 max-w-xl leading-relaxed">
                                                תכנון למידה מרוכז לקראת מבחנים קרובים, וארכיון הישגים וציונים מסודר לכל המבחנים שכבר התקיימו.
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

                                    {/* Segmented Sub-Tab Switcher for Upcoming vs Past Exams */}
                                    <div className="mt-6 pt-5 border-t border-stone-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 relative z-10">
                                        <div className="flex bg-stone-100 p-1.5 rounded-2xl border border-stone-200 gap-1.5 w-full sm:w-auto">
                                            <button 
                                                type="button" 
                                                onClick={() => setExamViewTab('upcoming')}
                                                className={`flex-1 sm:flex-initial px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-2 active:scale-95 ${examViewTab === 'upcoming' ? 'bg-white text-indigo-700 shadow-sm border border-stone-200/60' : 'text-stone-600 hover:text-stone-900'}`}
                                            >
                                                <span>🗓️</span> מבחנים קרובים
                                                <span className={`text-[11px] px-2 py-0.5 rounded-full font-black ${examViewTab === 'upcoming' ? 'bg-indigo-100 text-indigo-700' : 'bg-stone-200 text-stone-600'}`}>
                                                    {upcomingExams.length}
                                                </span>
                                            </button>
                                            <button 
                                                type="button" 
                                                onClick={() => setExamViewTab('past')}
                                                className={`flex-1 sm:flex-initial px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-2 active:scale-95 ${examViewTab === 'past' ? 'bg-white text-purple-700 shadow-sm border border-stone-200/60' : 'text-stone-600 hover:text-stone-900'}`}
                                            >
                                                <span>📜</span> מבחנים שהתקיימו (ארכיון)
                                                <span className={`text-[11px] px-2 py-0.5 rounded-full font-black ${examViewTab === 'past' ? 'bg-purple-100 text-purple-700' : 'bg-stone-200 text-stone-600'}`}>
                                                    {pastExams.length}
                                                </span>
                                            </button>
                                        </div>
                                        {examViewTab === 'upcoming' && upcomingExams.length > 0 && (
                                            <div className="text-xs text-stone-400 font-medium text-right sm:text-left">
                                                ממוין לפי תאריך המבחן הקרוב ביותר
                                            </div>
                                        )}
                                    </div>

                                    {/* 1. UPCOMING EXAMS VIEW */}
                                    {examViewTab === 'upcoming' && (
                                        upcomingExams.length > 0 ? (
                                            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 relative z-10 animate-[fadeIn_0.2s_ease-out]">
                                                {upcomingExams.map(exam => {
                                                    const sub = activeUserData.subjects.find(s=>s.id === exam.subjectId);
                                                    const examCountdown = getExamCountdown(exam.date, exam.time);
                                                    return (
                                                        <div key={exam.id} className="p-5 rounded-3xl border border-indigo-100 bg-white shadow-sm hover:shadow-md transition-all flex flex-col justify-between">
                                                            <div>
                                                                <div className="flex justify-between items-start mb-2 gap-2 flex-wrap">
                                                                    <div className="flex items-center gap-2 flex-wrap">
                                                                        <div className="text-xs font-bold text-stone-500 flex items-center gap-1.5" dir="ltr">
                                                                            <span>{new Date(exam.date).toLocaleDateString('he-IL')}</span>
                                                                            {exam.time && <span className="text-stone-700 font-extrabold">• ⏰ {exam.time}</span>}
                                                                        </div>
                                                                        {examCountdown && (
                                                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${examCountdown.badgeClass}`}>
                                                                                {examCountdown.text}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    {exam.cancellations > 0 && (
                                                                        <div className="text-[10px] font-bold text-rose-600 bg-rose-100 px-1.5 rounded">
                                                                            ביטולים: {exam.cancellations}/3
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="font-bold text-lg leading-tight text-stone-800">
                                                                    {exam.examName || 'מבחן'} ב{sub?.name || 'כללי'}
                                                                </div>
                                                                {(() => {
                                                                    const examTasks = (activeUserData.tasks || []).filter(t => t.examId === exam.id && !t.givenUp);
                                                                    const completedSessions = examTasks.filter(t => t.completed || t.completedAt).length;
                                                                    const openSessions = examTasks.filter(t => !t.completed && !t.completedAt).length;
                                                                    const totalSessions = Math.max(exam.sessionsCount || 0, completedSessions + openSessions);

                                                                    if (exam.targetHours > 0) {
                                                                        if (completedSessions > 0) {
                                                                            return (
                                                                                <div className="text-xs font-bold mt-2 bg-emerald-50 text-emerald-800 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-200 shadow-2xs">
                                                                                    <span>🎯</span>
                                                                                    <span>הושלמו {completedSessions}/{totalSessions} מפגשים ({exam.targetHours} שעות)</span>
                                                                                </div>
                                                                            );
                                                                        }
                                                                        return (
                                                                            <div className="text-xs text-stone-500 mt-2 bg-stone-50 inline-block px-2 py-1 rounded-lg border border-stone-200">
                                                                                תוכננו {totalSessions} מפגשים ({exam.targetHours} שעות)
                                                                            </div>
                                                                        );
                                                                    }

                                                                    if (completedSessions > 0) {
                                                                        return (
                                                                            <div className="text-xs font-bold mt-2 bg-emerald-50 text-emerald-800 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-200 shadow-2xs">
                                                                                <span>{openSessions === 0 ? '✅' : '🎯'}</span>
                                                                                <span>
                                                                                    {openSessions > 0 
                                                                                        ? (completedSessions === 1 ? `הושלם סשן 1 (${openSessions} בתהליך)` : `הושלמו ${completedSessions} סשנים (${openSessions} בתהליך)`)
                                                                                        : (completedSessions === 1 ? 'הושלם סשן 1 למבחן' : `הושלמו ${completedSessions} סשנים למבחן`)}
                                                                                </span>
                                                                            </div>
                                                                        );
                                                                    }

                                                                    if (openSessions > 0) {
                                                                        return (
                                                                            <div className="text-xs font-bold mt-2 bg-amber-50 text-amber-900 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-amber-200 shadow-2xs">
                                                                                <span>⚡</span>
                                                                                <span>{openSessions === 1 ? 'תוכנן סשן למידה 1' : `תוכננו ${openSessions} סשני למידה`}</span>
                                                                            </div>
                                                                        );
                                                                    }

                                                                    return (
                                                                        <div className="text-xs text-stone-400 mt-2 bg-stone-50 inline-block px-2 py-1 rounded-lg border border-stone-200">
                                                                            ללא תוכנית שעות
                                                                        </div>
                                                                    );
                                                                })()}
                                                            </div>

                                                            <div className="flex gap-2 w-full mt-4 pt-3 border-t border-stone-100 items-center">
                                                                {!exam.grade ? (
                                                                    <button 
                                                                        onClick={() => { setActiveExamForGrade(exam); toggleModal('examGrade', true); }} 
                                                                        className="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-sm font-bold py-2.5 rounded-2xl transition-all flex items-center justify-center gap-1.5 active:scale-95 shadow-xs">
                                                                        <span>✍️</span> הזנת ציון
                                                                    </button>
                                                                ) : (
                                                                    <div className="flex-1 bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-bold py-2.5 px-3 rounded-2xl flex items-center justify-center gap-1.5 shadow-xs">
                                                                        <span>🏆</span> ציון: <span className="text-sm font-black">{exam.grade}</span>
                                                                    </div>
                                                                )}
                                                                <button 
                                                                    onClick={() => setExamActionsMenu(exam)} 
                                                                    className="px-3.5 py-2.5 bg-stone-50 hover:bg-stone-100 text-stone-600 border border-stone-200 rounded-2xl transition-all font-bold text-sm flex items-center justify-center gap-1.5 active:scale-95 shadow-xs" 
                                                                    title="אפשרויות נוספות">
                                                                    <span className="text-base font-black leading-none">⋯</span>
                                                                    <span className="text-xs">אפשרויות</span>
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <div className="mt-6 p-8 rounded-3xl bg-stone-50/80 border border-dashed border-stone-200 text-center relative z-10 animate-[fadeIn_0.2s_ease-out]">
                                                <div className="text-4xl mb-2">🥳</div>
                                                <h3 className="text-lg font-bold text-stone-800">אין מבחנים קרובים ברשימה</h3>
                                                <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
                                                    כל הכבוד! לוח המבחנים הקרוב שלך פנוי. לחצי על "הוספה מהירה" או "תכנון למידה חכם" כדי להוסיף מבחן חדש.
                                                </p>
                                                <div className="flex flex-wrap justify-center gap-3 mt-4">
                                                    <button onClick={() => toggleModal('quickExam', true)} className="bg-indigo-600 text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-indigo-700 transition-all active:scale-95 shadow-xs">
                                                        + הוספת מבחן חדש
                                                    </button>
                                                    {pastExams.length > 0 && (
                                                        <button onClick={() => setExamViewTab('past')} className="bg-white text-stone-700 border border-stone-200 text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-stone-100 transition-all active:scale-95">
                                                            לצפייה במבחנים שהתקיימו ({pastExams.length}) 📜
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    )}

                                    {/* 2. PAST EXAMS ARCHIVE VIEW */}
                                    {examViewTab === 'past' && (
                                        <div className="mt-5 space-y-4 relative z-10 animate-[fadeIn_0.2s_ease-out]">
                                            {/* Summary Stats Banner */}
                                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                                <div className="bg-purple-50/70 border border-purple-100 p-3.5 rounded-2xl">
                                                    <div className="text-[11px] font-bold text-purple-700">🎓 סה"כ מבחנים</div>
                                                    <div className="text-2xl font-black text-purple-900 mt-0.5">{pastExams.length}</div>
                                                </div>
                                                <div className="bg-emerald-50/70 border border-emerald-100 p-3.5 rounded-2xl">
                                                    <div className="text-[11px] font-bold text-emerald-700">🏆 ממוצע ציונים</div>
                                                    <div className="text-2xl font-black text-emerald-900 mt-0.5">{avgPastGrade ? avgPastGrade : '—'}</div>
                                                </div>
                                                <div className="bg-amber-50/70 border border-amber-100 p-3.5 rounded-2xl">
                                                    <div className="text-[11px] font-bold text-amber-700">🌟 ציון שיא</div>
                                                    <div className="text-2xl font-black text-amber-900 mt-0.5">{highestPastGrade !== null ? highestPastGrade : '—'}</div>
                                                </div>
                                                <div className="bg-stone-50 border border-stone-200 p-3.5 rounded-2xl">
                                                    <div className="text-[11px] font-bold text-stone-600">⏳ ממתינים לציון</div>
                                                    <div className="text-2xl font-black text-stone-800 mt-0.5">{pendingGradeCount}</div>
                                                </div>
                                            </div>

                                            {/* Subject Filters */}
                                            {pastSubjects.length > 1 && (
                                                <div className="flex flex-wrap gap-2 pt-1 pb-1">
                                                    <button 
                                                        onClick={() => setPastExamSubjectFilter('all')}
                                                        className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all border active:scale-95 ${
                                                            pastExamSubjectFilter === 'all' 
                                                                ? 'bg-purple-700 text-white border-purple-700 shadow-xs' 
                                                                : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                                                        }`}
                                                    >
                                                        הכל ({pastExams.length})
                                                    </button>
                                                    {pastSubjects.map(sub => {
                                                        const count = pastExams.filter(e => e.subjectId === sub.id).length;
                                                        return (
                                                            <button 
                                                                key={sub.id}
                                                                onClick={() => setPastExamSubjectFilter(sub.id)}
                                                                className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all border flex items-center gap-1.5 active:scale-95 ${
                                                                    pastExamSubjectFilter === sub.id 
                                                                        ? 'bg-purple-100 text-purple-900 border-purple-300 shadow-xs' 
                                                                        : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                                                                }`}
                                                            >
                                                                <span>{sub.emoji}</span> {sub.name} ({count})
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            )}

                                            {/* Past Exams Grid */}
                                            {pastExams.length > 0 ? (
                                                filteredPastExams.length > 0 ? (
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                                        {filteredPastExams.map(exam => {
                                                            const sub = activeUserData.subjects.find(s=>s.id === exam.subjectId);
                                                            const pastLabel = typeof formatPastExamDate === 'function' ? formatPastExamDate(exam.date) : 'התקיים';
                                                            const gradeNum = exam.grade ? Number(exam.grade) : null;
                                                            const gradeBadgeColor = gradeNum >= 90 
                                                                ? 'bg-emerald-100 text-emerald-800 border-emerald-200' 
                                                                : gradeNum >= 80 
                                                                ? 'bg-indigo-100 text-indigo-800 border-indigo-200' 
                                                                : gradeNum >= 70 
                                                                ? 'bg-amber-100 text-amber-800 border-amber-200' 
                                                                : 'bg-stone-100 text-stone-800 border-stone-200';

                                                            return (
                                                                <div key={exam.id} className="p-5 rounded-3xl border border-stone-200 bg-stone-50/70 hover:bg-white hover:border-purple-200 shadow-xs hover:shadow-md transition-all flex flex-col justify-between">
                                                                    <div>
                                                                        <div className="flex justify-between items-start mb-2 gap-2 flex-wrap">
                                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                                <span className="text-[11px] font-bold text-stone-500 bg-white px-2 py-0.5 rounded-lg border border-stone-200" dir="ltr">
                                                                                    {new Date(exam.date).toLocaleDateString('he-IL')}{exam.time ? ` • ⏰ ${exam.time}` : ''}
                                                                                </span>
                                                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-100">
                                                                                    {pastLabel}
                                                                                </span>
                                                                            </div>
                                                                        </div>

                                                                        <div className="font-bold text-lg leading-tight text-stone-800 mt-1">
                                                                            {exam.examName || 'מבחן'} ב{sub?.name || 'כללי'}
                                                                        </div>
                                                                        
                                                                        <div className="mt-3 p-3 rounded-2xl bg-white border border-stone-100 shadow-xs flex items-center justify-between">
                                                                            <span className="text-xs font-bold text-stone-500">ציון שהושג:</span>
                                                                            {exam.grade ? (
                                                                                <span className={`text-base font-black px-3 py-0.5 rounded-xl border shadow-xs ${gradeBadgeColor}`}>
                                                                                    {exam.grade}
                                                                                </span>
                                                                            ) : (
                                                                                <button 
                                                                                    onClick={() => { setActiveExamForGrade(exam); toggleModal('examGrade', true); }}
                                                                                    className="text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-3 py-1 rounded-xl transition-all active:scale-95"
                                                                                >
                                                                                    + הזיני ציון
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>

                                                                    <div className="flex gap-2 w-full mt-4 pt-3 border-t border-stone-200/60 items-center">
                                                                        <button 
                                                                            onClick={() => { setActiveExamForGrade(exam); toggleModal('examGrade', true); }} 
                                                                            className="flex-1 bg-white hover:bg-stone-50 text-stone-700 border border-stone-200 text-xs sm:text-sm font-bold py-2.5 rounded-2xl transition-all flex items-center justify-center gap-1.5 active:scale-95 shadow-xs">
                                                                            <span>✏️</span> {exam.grade ? 'עריכת ציון' : 'הזנת ציון'}
                                                                        </button>
                                                                        <button 
                                                                            onClick={() => setExamActionsMenu(exam)} 
                                                                            className="px-4 py-2.5 bg-white hover:bg-stone-50 text-stone-600 border border-stone-200 rounded-2xl transition-all font-bold text-sm flex items-center justify-center gap-1.5 active:scale-95 shadow-xs" 
                                                                            title="אפשרויות נוספות">
                                                                            <span className="text-base font-black leading-none">⋯</span>
                                                                            <span className="text-xs">אפשרויות</span>
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    <div className="p-8 rounded-3xl bg-stone-50 border border-dashed border-stone-200 text-center">
                                                        <div className="text-3xl mb-2">🔍</div>
                                                        <div className="text-sm font-bold text-stone-700">לא נמצאו מבחנים במקצוע שנבחר</div>
                                                        <button onClick={() => setPastExamSubjectFilter('all')} className="mt-3 text-xs text-purple-700 font-bold underline">
                                                            הצג את כל המבחנים בארכיון
                                                        </button>
                                                    </div>
                                                )
                                            ) : (
                                                <div className="mt-4 p-8 rounded-3xl bg-stone-50/80 border border-dashed border-stone-200 text-center relative z-10 animate-[fadeIn_0.2s_ease-out]">
                                                    <div className="text-4xl mb-2">📜</div>
                                                    <h3 className="text-lg font-bold text-stone-800">אין עדיין מבחנים שהסתיימו בארכיון</h3>
                                                    <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
                                                        ברגע שיעבור תאריך של מבחן, הוא יישמר כאן אוטומטית בצורה מסודרת ונוחה עם אפשרות למעקב ציונים והפקת סיכומים!
                                                    </p>
                                                </div>
                                            )}
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

                                                    {/* צפייה ישירה או צירוף של דף העבודה / ש.ב */}
                                                    <div className="mt-3 mr-2">
                                                        {t.attachments && t.attachments.length > 0 ? (
                                                            <button 
                                                                type="button"
                                                                onClick={() => openAttachmentViewer(t)}
                                                                className="w-full py-2.5 px-4 bg-purple-50 hover:bg-purple-100 text-purple-900 border border-purple-200 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-98 shadow-xs"
                                                                title="פתיחת קובץ שיעורי הבית / דף העבודה"
                                                            >
                                                                <span>📎</span>
                                                                <span>צפייה בדף העבודה / בקובץ המשימה ({t.attachments.length})</span>
                                                                <span className="text-purple-700 bg-purple-200/70 px-2 py-0.5 rounded text-[11px] font-bold">פתיחה ↗</span>
                                                            </button>
                                                        ) : (
                                                            <label className="w-full py-2 px-3 bg-white hover:bg-purple-50/50 text-stone-600 hover:text-purple-700 border border-dashed border-stone-300 hover:border-purple-300 rounded-xl font-semibold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer">
                                                                <input 
                                                                    type="file" 
                                                                    multiple 
                                                                    accept="image/*,application/pdf" 
                                                                    className="hidden" 
                                                                    onChange={async (e) => {
                                                                        const files = Array.from(e.target.files || []);
                                                                        if (files.length === 0) return;
                                                                        await handleQuickAddAttachmentsToTask(t, files, 'homework');
                                                                        e.target.value = '';
                                                                    }} 
                                                                />
                                                                <span>➕</span>
                                                                <span>צירוף דף העבודה / צילום התרגיל למשימה זו</span>
                                                            </label>
                                                        )}
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
                                if (analyticsTimeFilter === 'last7') {
                                    const sevenDaysAgo = new Date();
                                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                                    return taskDate >= sevenDaysAgo;
                                }
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
                                if (analyticsTimeFilter === 'last7') {
                                    const sevenDaysAgo = new Date();
                                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                                    return exDate >= sevenDaysAgo;
                                }
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
                                const subTasksWithHours = completedTasks.filter(t => !t.isLessonLog && t.subjectId === sub.id && t.studyDurationHours);
                                const subHours = subTasksWithHours.reduce((sum, t) => sum + Number(t.studyDurationHours), 0);
                                return {
                                    ...sub,
                                    completedCount: subTasks.length,
                                    avgRating: avg ? parseFloat(avg) : null,
                                    totalStudyHours: subHours > 0 ? parseFloat(subHours.toFixed(1)) : 0
                                };
                            }).filter(s => s.completedCount > 0).sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));

                            const tasksWithDuration = completedTasks.filter(t => t.studyDurationHours && !isNaN(Number(t.studyDurationHours)));
                            const totalStudyHoursNum = tasksWithDuration.reduce((sum, t) => sum + Number(t.studyDurationHours), 0);
                            const totalStudyHours = totalStudyHoursNum > 0 ? parseFloat(totalStudyHoursNum.toFixed(1)) : 0;
                            const avgHoursPerSession = tasksWithDuration.length > 0 ? (totalStudyHoursNum / tasksWithDuration.length).toFixed(1) : null;

                            const allRatings = completedTasks.filter(t => !t.isLessonLog && t.understandingRating).map(t => t.understandingRating);
                            const overallAvgRating = allRatings.length > 0 ? (allRatings.reduce((a, b) => a + b, 0) / allRatings.length).toFixed(1) : null;

                            const gradedExams = exams.filter(e => e.grade);
                            const examAvg = gradedExams.length > 0 ? (gradedExams.reduce((sum, e) => sum + Number(e.grade), 0) / gradedExams.length).toFixed(1) : null;

                            const currentFilterLabel = analyticsTimeFilter === 'all' 
                                ? 'כל הזמנים 🌟' 
                                : analyticsTimeFilter === 'last7'
                                    ? 'השבוע (7 ימים אחרונים) 🗓️'
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
                                                onClick={() => setAnalyticsTimeFilter('last7')}
                                                className={`px-3.5 py-1.5 rounded-2xl text-xs md:text-sm font-bold transition-all active:scale-95 ${
                                                    analyticsTimeFilter === 'last7' 
                                                        ? 'bg-purple-600 text-white shadow-sm shadow-purple-200' 
                                                        : 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                                                }`}>
                                                השבוע (7 ימים) 🗓️
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

                                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5 md:gap-4">
                                        <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100">
                                            <div className="text-stone-400 text-xs font-semibold mb-1">סה"כ משימות שהושלמו</div>
                                            <div className="text-2xl md:text-3xl font-black text-stone-800">{completedTasks.length}</div>
                                            <div className="text-[11px] text-emerald-600 font-bold mt-1">מתוכן {onTimeCount} בזמן!</div>
                                        </div>
                                        <div className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100">
                                            <div className="text-stone-400 text-xs font-semibold mb-1">סה"כ שעות למידה ⏳</div>
                                            <div className="text-2xl md:text-3xl font-black text-indigo-600">{totalStudyHours > 0 ? `${totalStudyHours} שע'` : '0 שע\''}</div>
                                            <div className="text-[11px] text-stone-500 font-medium mt-1">
                                                {tasksWithDuration.length > 0 ? `ממוצע ${avgHoursPerSession} שע' לסשן (${tasksWithDuration.length} מתועדות)` : 'הזיני משך זמן בהגשת משימות'}
                                            </div>
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
                                                                    <div className="flex items-center gap-1.5 text-sm font-black text-stone-800">
                                                                        {sub.totalStudyHours > 0 && (
                                                                            <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-lg shadow-2xs">
                                                                                ⏳ {sub.totalStudyHours} שע'
                                                                            </span>
                                                                        )}
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
                            
                            const topUserPoints = Math.max(...allUsers.map(u => u?.weeklyPoints || 0), 0);
                            
                            // חיתוך למקומות ראשון, שני ושלישי בלבד (Top 3) לפי נקודות שבועיות
                            const sortedByPoints = [...allUsers].sort((a,b) => (b.weeklyPoints || 0) - (a.weeklyPoints || 0)).slice(0, 3);
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
                                        <div className="relative z-10 mb-6">
                                            <h3 className="font-black text-2xl text-stone-800 flex items-center gap-3">
                                                <span className="text-3xl drop-shadow-sm">🏆</span> טבלת אלופות שבועית
                                            </h3>
                                            <div className="text-xs text-amber-800 font-bold bg-amber-50/90 border border-amber-200 rounded-xl px-3 py-1.5 inline-flex items-center gap-1.5 mt-2">
                                                <span>⏳</span> התחרות ננעלת במוצאי שבת ב-22:00 ומוכתרת אלופת השבוע 👑
                                            </div>
                                        </div>
                                        <div className="space-y-4 relative z-10">
                                            {sortedByPoints.map((u, i) => {
                                                const points = u.weeklyPoints || 0;
                                                const topPoints = Math.max(sortedByPoints[0]?.weeklyPoints || 1, 1);
                                                const progressPct = Math.max(2, (points / topPoints) * 100);
                                                const gap = topUserPoints - points;
                                                const champBadge = (u.badges || []).find(b => b.id === 'b_weekly_champ');
                                                const champCount = champBadge?.count || (champBadge ? 1 : 0);
                                                
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
                                                                    <div className={`font-bold text-base md:text-lg flex items-center gap-2 flex-wrap ${u.isMe ? 'text-purple-800' : 'text-stone-800'}`}>
                                                                        <span>{u.name}</span>
                                                                        {u.isMe && <span className="text-[10px] bg-purple-600 text-white px-2 py-0.5 rounded-full font-bold shadow-sm">אני</span>}
                                                                        {champCount > 0 && (
                                                                            <span className="text-[11px] bg-amber-100 text-amber-900 border border-amber-300 px-2 py-0.5 rounded-full font-black flex items-center gap-1 shadow-xs" title={`אלופת השבוע ${champCount} פעמים`}>
                                                                                👑 {champCount > 1 ? `x${champCount}` : ''}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <div className="text-xs text-stone-400 font-medium mt-0.5" dir="ltr">@{u.isMe ? globalState.activeUser : (u.username || 'user')}</div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="font-black text-xl bg-white px-5 py-2 rounded-xl shadow-sm border border-stone-100 flex items-center gap-1.5 shrink-0" dir="ltr">
                                                            {points} <span className="text-xs text-stone-400 font-bold">השבוע</span>
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
                                        const displayStreak = liveData.taskStreak !== undefined ? liveData.taskStreak : (liveData.streak !== undefined ? liveData.streak : (friend.streak || friend.taskStreak || 0));
                                        
                                        return (
                                        <div key={friend.id} className="bg-white p-5 rounded-3xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.03)] border border-stone-100 cursor-pointer hover:border-purple-300 hover:shadow-lg transition-all group relative overflow-hidden active:scale-95" onClick={() => {
                                            setActiveFriend(friend);
                                            if (!liveFriends[friend.username] && typeof db !== 'undefined' && db) {
                                                db.collection("users").doc(friend.username).get().then(doc => {
                                                    if (doc.exists) {
                                                        setLiveFriends(prev => ({ ...prev, [friend.username]: { ...doc.data(), username: friend.username } }));
                                                    }
                                                }).catch(e => console.warn(e));
                                            }
                                            toggleModal('friend', true);
                                        }}>
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
                                                const earned = userBadges.find(b => (typeof b === 'string' ? b === badge.id : b?.id === badge.id));
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
                                    <button onClick={()=>{ toggleModal('task',false); setTaskFormAttachments([]); }} className="text-stone-400 hover:text-stone-600 bg-stone-100 p-2 rounded-full transition-colors active:scale-95"><IconX className="w-4 h-4"/></button>
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

                                    {/* 1. צילומי לוח מהשיעור */}
                                    <div className="pt-2 border-t border-stone-100">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <label className="text-xs font-bold text-stone-600 uppercase tracking-wide flex items-center gap-1.5">
                                                <span>📸</span>
                                                צילום לוח מהשיעור (תמונות מהכיתה)
                                            </label>
                                            {taskFormAttachments.filter(a => a.category === 'board').length > 0 && (
                                                <span className="text-[11px] font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full">
                                                    {taskFormAttachments.filter(a => a.category === 'board').length} צילומי לוח
                                                </span>
                                            )}
                                        </div>
                                        
                                        <label className="flex items-center justify-center gap-2 p-2.5 border-2 border-dashed border-purple-200 hover:border-purple-400 rounded-2xl cursor-pointer bg-purple-50/30 hover:bg-purple-50/60 transition-all text-xs font-bold text-purple-900 active:scale-[0.99]">
                                            <input 
                                                type="file" 
                                                multiple 
                                                accept="image/*" 
                                                className="hidden" 
                                                onChange={(e) => handleFilesSelected(e, 'new', 'board')} 
                                                disabled={isUploadingAttachment}
                                            />
                                            {isUploadingAttachment ? (
                                                <span className="flex items-center gap-2 text-purple-600 animate-pulse">
                                                    <span>מעבד תמונה... ⏳</span>
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2">
                                                    <span className="text-base">📷</span>
                                                    <span>העלאת צילום לוח</span>
                                                </span>
                                            )}
                                        </label>

                                        {taskFormAttachments.filter(a => a.category === 'board').length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {taskFormAttachments.map((att, idx) => {
                                                    if (att.category !== 'board') return null;
                                                    return (
                                                        <div key={att.id || idx} className="flex items-center gap-1.5 bg-purple-50 border border-purple-200 text-purple-900 text-xs px-2.5 py-1.5 rounded-xl font-medium max-w-full">
                                                            <span>📸</span>
                                                            <span className="truncate max-w-[130px]" title={att.name}>{att.name}</span>
                                                            <span className="text-[10px] text-purple-500">({Math.round((att.size || 0) / 1024)}KB)</span>
                                                            <button 
                                                                type="button" 
                                                                onClick={() => setTaskFormAttachments(prev => prev.filter((_, i) => i !== idx))} 
                                                                className="text-stone-400 hover:text-rose-500 mr-1 p-0.5"
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {/* 2. קבצי שיעורי בית ודפי עבודה (אם יש ש.ב) */}
                                    {taskFormHasHW && (
                                        <div className="pt-2 border-t border-stone-100">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <label className="text-xs font-bold text-stone-600 uppercase tracking-wide flex items-center gap-1.5">
                                                    <span>📄</span>
                                                    דפי עבודה וקובצי ש.ב (PDF / תמונות)
                                                </label>
                                                {taskFormAttachments.filter(a => a.category === 'homework' || (!a.category && a.category !== 'board')).length > 0 && (
                                                    <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full">
                                                        {taskFormAttachments.filter(a => a.category === 'homework' || (!a.category && a.category !== 'board')).length} קבצי ש.ב
                                                    </span>
                                                )}
                                            </div>
                                            
                                            <label className="flex items-center justify-center gap-2 p-2.5 border-2 border-dashed border-indigo-200 hover:border-indigo-400 rounded-2xl cursor-pointer bg-indigo-50/30 hover:bg-indigo-50/60 transition-all text-xs font-bold text-indigo-900 active:scale-[0.99]">
                                                <input 
                                                    type="file" 
                                                    multiple 
                                                    accept="image/*,application/pdf" 
                                                    className="hidden" 
                                                    onChange={(e) => handleFilesSelected(e, 'new', 'homework')} 
                                                    disabled={isUploadingAttachment}
                                                />
                                                {isUploadingAttachment ? (
                                                    <span className="flex items-center gap-2 text-indigo-600 animate-pulse">
                                                        <span>מעבד קובץ... ⏳</span>
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-2">
                                                        <span className="text-base">📑</span>
                                                        <span>העלאת דף עבודה / קובץ ש.ב</span>
                                                    </span>
                                                )}
                                            </label>

                                            {taskFormAttachments.filter(a => a.category === 'homework' || (!a.category && a.category !== 'board')).length > 0 && (
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    {taskFormAttachments.map((att, idx) => {
                                                        if (att.category === 'board') return null;
                                                        return (
                                                            <div key={att.id || idx} className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs px-2.5 py-1.5 rounded-xl font-medium max-w-full">
                                                                <span>{att.type === 'application/pdf' || att.name?.toLowerCase().endsWith('.pdf') ? '📄' : '🖼️'}</span>
                                                                <span className="truncate max-w-[130px]" title={att.name}>{att.name}</span>
                                                                <span className="text-[10px] text-indigo-500">({Math.round((att.size || 0) / 1024)}KB)</span>
                                                                <button 
                                                                    type="button" 
                                                                    onClick={() => setTaskFormAttachments(prev => prev.filter((_, i) => i !== idx))} 
                                                                    className="text-stone-400 hover:text-rose-500 mr-1 p-0.5"
                                                                >
                                                                    ✕
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
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
                                    {editingTask.completed && !editingTask.isLessonLog && (
                                        <div className="bg-indigo-50/50 p-3.5 rounded-2xl border border-indigo-100">
                                            <label className="text-xs font-bold text-indigo-900 block mb-1 uppercase flex items-center gap-1.5">
                                                <span>⏳</span> משך למידה בפועל (בשעות - אופציונלי)
                                            </label>
                                            <input 
                                                name="studyDurationHours" 
                                                type="number" 
                                                step="0.25" 
                                                min="0.1" 
                                                max="24" 
                                                defaultValue={editingTask.studyDurationHours || ''} 
                                                placeholder="למשל: 1.5, 3, 3.5..." 
                                                className="w-full p-2.5 bg-white border border-indigo-200 rounded-xl text-sm font-bold text-stone-800 outline-none focus:ring-2 focus:ring-indigo-300" 
                                            />
                                            {editingTask.studyTimeRange && (
                                                <div className="text-[11px] text-indigo-700 mt-1 font-semibold">
                                                    תועד: {editingTask.studyTimeRange}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* 1. צילומי לוח מהשיעור בעריכה */}
                                    <div className="pt-2 border-t border-stone-100">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <label className="text-xs font-bold text-stone-600 uppercase tracking-wide flex items-center gap-1.5">
                                                <span>📸</span>
                                                צילום לוח מהשיעור (תמונות מהכיתה)
                                            </label>
                                            {editTaskAttachments.filter(a => a.category === 'board').length > 0 && (
                                                <span className="text-[11px] font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full">
                                                    {editTaskAttachments.filter(a => a.category === 'board').length} צילומי לוח
                                                </span>
                                            )}
                                        </div>
                                        
                                        <label className="flex items-center justify-center gap-2 p-2.5 border-2 border-dashed border-purple-200 hover:border-purple-400 rounded-2xl cursor-pointer bg-purple-50/30 hover:bg-purple-50/60 transition-all text-xs font-bold text-purple-900 active:scale-[0.99]">
                                            <input 
                                                type="file" 
                                                multiple 
                                                accept="image/*" 
                                                className="hidden" 
                                                onChange={(e) => handleFilesSelected(e, 'edit', 'board')} 
                                                disabled={isUploadingAttachment}
                                            />
                                            {isUploadingAttachment ? (
                                                <span className="flex items-center gap-2 text-purple-600 animate-pulse">
                                                    <span>מעבד תמונה... ⏳</span>
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2">
                                                    <span className="text-base">📷</span>
                                                    <span>הוספת צילום לוח</span>
                                                </span>
                                            )}
                                        </label>

                                        {editTaskAttachments.filter(a => a.category === 'board').length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {editTaskAttachments.map((att, idx) => {
                                                    if (att.category !== 'board') return null;
                                                    return (
                                                        <div key={att.id || idx} className="flex items-center gap-1.5 bg-purple-50 border border-purple-200 text-purple-900 text-xs px-2.5 py-1.5 rounded-xl font-medium max-w-full">
                                                            <span>📸</span>
                                                            <span className="truncate max-w-[130px]" title={att.name}>{att.name}</span>
                                                            <span className="text-[10px] text-purple-500">({Math.round((att.size || 0) / 1024)}KB)</span>
                                                            <button 
                                                                type="button" 
                                                                onClick={() => setEditTaskAttachments(prev => prev.filter((_, i) => i !== idx))} 
                                                                className="text-stone-400 hover:text-rose-500 mr-1 p-0.5"
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {/* 2. דפי עבודה ושיעורי בית בעריכה */}
                                    <div className="pt-2 border-t border-stone-100">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <label className="text-xs font-bold text-stone-600 uppercase tracking-wide flex items-center gap-1.5">
                                                <span>📄</span>
                                                דפי עבודה וקובצי ש.ב (PDF / תמונות)
                                            </label>
                                            {editTaskAttachments.filter(a => a.category === 'homework' || (!a.category && a.category !== 'board')).length > 0 && (
                                                <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full">
                                                    {editTaskAttachments.filter(a => a.category === 'homework' || (!a.category && a.category !== 'board')).length} קבצי ש.ב
                                                </span>
                                            )}
                                        </div>
                                        
                                        <label className="flex items-center justify-center gap-2 p-2.5 border-2 border-dashed border-indigo-200 hover:border-indigo-400 rounded-2xl cursor-pointer bg-indigo-50/30 hover:bg-indigo-50/60 transition-all text-xs font-bold text-indigo-900 active:scale-[0.99]">
                                            <input 
                                                type="file" 
                                                multiple 
                                                accept="image/*,application/pdf" 
                                                className="hidden" 
                                                onChange={(e) => handleFilesSelected(e, 'edit', 'homework')} 
                                                disabled={isUploadingAttachment}
                                            />
                                            {isUploadingAttachment ? (
                                                <span className="flex items-center gap-2 text-indigo-600 animate-pulse">
                                                    <span>מעבד קובץ... ⏳</span>
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2">
                                                    <span className="text-base">📑</span>
                                                    <span>הוספת דף עבודה / קובץ ש.ב</span>
                                                </span>
                                            )}
                                        </label>

                                        {editTaskAttachments.filter(a => a.category === 'homework' || (!a.category && a.category !== 'board')).length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {editTaskAttachments.map((att, idx) => {
                                                    if (att.category === 'board') return null;
                                                    return (
                                                        <div key={att.id || idx} className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs px-2.5 py-1.5 rounded-xl font-medium max-w-full">
                                                            <span>{att.type === 'application/pdf' || att.name?.toLowerCase().endsWith('.pdf') ? '📄' : '🖼️'}</span>
                                                            <span className="truncate max-w-[130px]" title={att.name}>{att.name}</span>
                                                            <span className="text-[10px] text-indigo-500">({Math.round((att.size || 0) / 1024)}KB)</span>
                                                            <button 
                                                                type="button" 
                                                                onClick={() => setEditTaskAttachments(prev => prev.filter((_, i) => i !== idx))} 
                                                                className="text-stone-400 hover:text-rose-500 mr-1 p-0.5"
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    <button type="submit" className="w-full bg-stone-800 text-white rounded-2xl py-3.5 font-bold">שמירת עריכה</button>
                                </form>
                            </div>
                        </div>
                    )}



                    {modals.complete && activeTask && (() => {
                        const onTimeSubmitted = typeof isTaskSubmittedOnTime === 'function' ? isTaskSubmittedOnTime(activeTask) : false;
                        const dueTimeStr = activeTask.dueTime || '23:59:59';
                        const taskDueDateTime = activeTask.dueDate ? new Date(`${activeTask.dueDate}T${dueTimeStr}`) : null;
                        const GRACE_PERIOD_MS = 5 * 60 * 1000;
                        const activeTaskIsLate = !activeTask.isFlexibleExamSession && !activeTask.rewardPoints && !onTimeSubmitted && taskDueDateTime ? (new Date().getTime() > (taskDueDateTime.getTime() + GRACE_PERIOD_MS)) : false;
                        
                        return (
                            <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4">
                                <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 shadow-2xl relative overflow-y-auto max-h-[90vh] custom-scrollbar animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8">
                                    <div className={`absolute top-0 left-0 w-full h-2 ${activeTaskIsLate ? 'bg-rose-400' : 'bg-emerald-400'}`}></div>
                                    <div className="flex justify-between items-start mb-2 mt-2">
                                        <h3 className="font-bold text-xl text-stone-800">סיום משימה:<br/><span className={activeTaskIsLate ? 'text-rose-600' : 'text-emerald-600'}>{activeTask.title}</span></h3>
                                        <button onClick={()=>{toggleModal('complete',false); setActiveTask(null);}} className="text-stone-400 bg-stone-100 p-2 rounded-full active:scale-95"><IconX className="w-4 h-4"/></button>
                                    </div>
                                    
                                    {(activeTask.isFlexibleExamSession || activeTask.rewardPoints) && (
                                        <div className="bg-gradient-to-r from-amber-50 to-orange-50 text-amber-950 p-3 rounded-2xl border border-amber-200 text-xs font-bold mb-4 flex items-center justify-between shadow-2xs">
                                            <span className="flex items-center gap-1.5"><span>⚡</span> סשן למידה למבחן:</span>
                                            <span className="bg-amber-200 text-amber-950 px-2.5 py-0.5 rounded-lg font-black">+3 נקודות ישירות למדד! 🏆</span>
                                        </div>
                                    )}

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
                                        const durationInfo = calculateStudyDuration(studyTimeMode, studyDurationHoursInput, studyTimeStart, studyTimeEnd);
                                        handleCompleteTask(activeTask, Number(e.target.rating.value), e.target.hard.value, chosenReason, durationInfo);
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

                                        {/* משך זמן הלמידה (אופציונלי - בחירה) */}
                                        <div className="bg-indigo-50/60 p-4 md:p-5 rounded-2xl border border-indigo-100 space-y-3">
                                            <div className="flex justify-between items-center gap-2">
                                                <label className="text-sm font-bold text-indigo-950 flex items-center gap-1.5">
                                                    <span>⏳</span> כמה זמן למדת? <span className="text-xs font-normal text-indigo-600">(בחירה - לא חובה)</span>
                                                </label>
                                                <div className="flex bg-white p-0.5 rounded-xl border border-indigo-200/80 text-xs font-bold shrink-0">
                                                    <button
                                                        type="button"
                                                        onClick={() => setStudyTimeMode('direct')}
                                                        className={`px-2.5 py-1 rounded-lg transition-all ${
                                                            studyTimeMode === 'direct' 
                                                                ? 'bg-indigo-600 text-white shadow-xs' 
                                                                : 'text-indigo-600 hover:text-indigo-800'
                                                        }`}
                                                    >
                                                        לפי שעות
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setStudyTimeMode('range')}
                                                        className={`px-2.5 py-1 rounded-lg transition-all ${
                                                            studyTimeMode === 'range' 
                                                                ? 'bg-indigo-600 text-white shadow-xs' 
                                                                : 'text-indigo-600 hover:text-indigo-800'
                                                        }`}
                                                    >
                                                        בין שעות
                                                    </button>
                                                </div>
                                            </div>

                                            {studyTimeMode === 'direct' ? (
                                                <div className="space-y-2.5">
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="number"
                                                            step="0.25"
                                                            min="0.1"
                                                            max="24"
                                                            placeholder="למשל: 1.5, 3, 3.5..."
                                                            value={studyDurationHoursInput}
                                                            onChange={(e) => setStudyDurationHoursInput(e.target.value)}
                                                            className="flex-1 p-3 bg-white border border-indigo-200 rounded-xl text-sm font-bold text-stone-800 outline-none focus:ring-2 focus:ring-indigo-300"
                                                        />
                                                        <span className="text-sm font-bold text-indigo-900 whitespace-nowrap">שעות</span>
                                                        {studyDurationHoursInput && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setStudyDurationHoursInput('')}
                                                                className="text-stone-400 hover:text-rose-500 text-xs font-bold px-2 py-1"
                                                                title="איפוס"
                                                            >
                                                                ✕
                                                            </button>
                                                        )}
                                                    </div>

                                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                                        {[
                                                            { label: '30 דק\'', val: '0.5' },
                                                            { label: 'שעה', val: '1' },
                                                            { label: '1.5 שע\'', val: '1.5' },
                                                            { label: 'שעתיים', val: '2' },
                                                            { label: '2.5 שע\'', val: '2.5' },
                                                            { label: '3 שעות', val: '3' },
                                                            { label: '3.5 שע\'', val: '3.5' },
                                                            { label: '4 שעות', val: '4' }
                                                        ].map(chip => (
                                                            <button
                                                                key={chip.val}
                                                                type="button"
                                                                onClick={() => setStudyDurationHoursInput(chip.val)}
                                                                className={`text-xs px-2.5 py-1 rounded-lg border transition-all active:scale-95 font-semibold ${
                                                                    studyDurationHoursInput === chip.val
                                                                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs'
                                                                        : 'bg-white text-indigo-700 border-indigo-200/70 hover:bg-indigo-100/50'
                                                                }`}
                                                            >
                                                                {chip.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div>
                                                            <label className="text-[11px] font-bold text-indigo-900 mb-1 block">משעה:</label>
                                                            <input
                                                                type="time"
                                                                value={studyTimeStart}
                                                                onChange={(e) => setStudyTimeStart(e.target.value)}
                                                                className="w-full p-2.5 bg-white border border-indigo-200 rounded-xl text-sm font-bold text-stone-800 outline-none focus:ring-2 focus:ring-indigo-300"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-[11px] font-bold text-indigo-900 mb-1 block">עד שעה:</label>
                                                            <input
                                                                type="time"
                                                                value={studyTimeEnd}
                                                                onChange={(e) => setStudyTimeEnd(e.target.value)}
                                                                className="w-full p-2.5 bg-white border border-indigo-200 rounded-xl text-sm font-bold text-stone-800 outline-none focus:ring-2 focus:ring-indigo-300"
                                                            />
                                                        </div>
                                                    </div>

                                                    {studyTimeStart && studyTimeEnd && (() => {
                                                        const dur = calculateStudyDuration('range', '', studyTimeStart, studyTimeEnd);
                                                        if (!dur) return null;
                                                        return (
                                                            <div className="bg-white/90 p-2.5 rounded-xl border border-indigo-200 text-xs font-bold text-indigo-900 flex items-center justify-between shadow-2xs">
                                                                <span>✨ חושב אוטומטית:</span>
                                                                <span className="text-indigo-700">{dur.studyTimeRange}</span>
                                                            </div>
                                                        );
                                                    })()}

                                                    {(studyTimeStart || studyTimeEnd) && (
                                                        <div className="flex justify-end">
                                                            <button
                                                                type="button"
                                                                onClick={() => { setStudyTimeStart(''); setStudyTimeEnd(''); }}
                                                                className="text-stone-400 hover:text-rose-500 text-xs font-bold"
                                                            >
                                                                איפוס שעות ✕
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
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
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">תאריך</label>
                                            <input type="date" name="date" required className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-indigo-400 font-bold" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">שעה (אופציונלי)</label>
                                            <input type="time" name="time" className="w-full p-4 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-indigo-400 font-bold" />
                                        </div>
                                    </div>
                                    <button type="submit" className="w-full bg-indigo-600 text-white py-4 mt-2 rounded-xl text-sm font-bold shadow-md hover:bg-indigo-700 transition-all active:scale-95">שמירת המבחן</button>
                                </form>
                            </div>
                        </div>
                    )}


                    {modals.singleExamSession && (
                        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[70] flex items-end md:items-center justify-center p-0 md:p-4 animate-[fadeIn_0.2s_ease-out]">
                            <div className="bg-white rounded-t-[32px] md:rounded-[32px] w-full max-w-md p-6 md:p-8 shadow-2xl animate-[slideUp_0.3s_ease-out] pb-safe-bottom md:pb-8 max-h-[90vh] overflow-y-auto custom-scrollbar">
                                <div className="flex justify-between items-center mb-5">
                                    <h3 className="font-bold text-xl text-stone-800 flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 font-black">⚡</div>
                                        מפגש למידה למבחן
                                    </h3>
                                    <button onClick={() => toggleModal('singleExamSession', false)} className="bg-stone-100 p-2 rounded-full text-stone-400 hover:text-stone-600 active:scale-95 transition-colors">
                                        <IconX className="w-4 h-4"/>
                                    </button>
                                </div>

                                <form onSubmit={handleCreateSingleExamSession} className="space-y-4">
                                    <div className="bg-gradient-to-r from-amber-50 to-orange-50 p-3.5 rounded-2xl border border-amber-200 text-xs text-amber-900 font-medium leading-relaxed">
                                        <div className="font-bold flex items-center gap-1.5 text-amber-950 mb-1">
                                            <span>🎯</span> סשן למידה ללא התחייבות:
                                        </div>
                                        יוצר מפגש למידה אחד ממוקד למבחן שתבחרי, בלי צורך לחלק שעות או להתחייב למספר מפגשים. <b className="text-amber-800">בסיום המפגש תקבלי 3 נקודות ישירות למדד!</b> 🏆
                                    </div>

                                    {/* Exam Selection */}
                                    <div>
                                        <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">עבור איזה מבחן?</label>
                                        {(activeUserData.exams && activeUserData.exams.length > 0) ? (
                                            <div className="space-y-2">
                                                <select 
                                                    value={singleExamSessionData.examId} 
                                                    onChange={(e) => {
                                                        const newId = e.target.value;
                                                        const ex = (activeUserData.exams || []).find(x => x.id === newId);
                                                        const nextNum = ex ? getNextSessionNumberForExam(ex.id, activeUserData.tasks) : 1;
                                                        setSingleExamSessionData(prev => ({
                                                            ...prev,
                                                            examId: newId,
                                                            title: ex ? `ללמוד למבחן: ${ex.examName || 'מבחן'} - סשן ${nextNum}` : (prev.title || 'ללמוד למבחן - סשן 1')
                                                        }));
                                                    }}
                                                    className="w-full p-3.5 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-amber-400 font-bold transition-all"
                                                >
                                                    <option value="">בחרי מבחן מהרשימה...</option>
                                                    {activeUserData.exams.map(ex => {
                                                        const sub = (activeUserData.subjects || []).find(s => s.id === ex.subjectId);
                                                        return (
                                                            <option key={ex.id} value={ex.id}>
                                                                {ex.examName || 'מבחן'} — {sub ? sub.name : 'כללי'} ({ex.date ? new Date(ex.date).toLocaleDateString('he-IL') : ''})
                                                            </option>
                                                        );
                                                    })}
                                                    <option value="__other__">+ מבחן אחר (הקלדה ידנית)</option>
                                                </select>
                                                {singleExamSessionData.examId === '__other__' && (
                                                    <div className="space-y-2 pt-1 animate-[fadeIn_0.2s_ease-out]">
                                                        <input 
                                                            type="text" 
                                                            placeholder="שם המבחן (למשל: בוחן בפיזיקה)" 
                                                            value={singleExamSessionData.customExamName || ''} 
                                                            onChange={(e) => setSingleExamSessionData(prev => ({ ...prev, customExamName: e.target.value }))}
                                                            required 
                                                            className="w-full p-3 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-amber-400 font-bold"
                                                        />
                                                        <select 
                                                            value={singleExamSessionData.customSubjectId || ''} 
                                                            onChange={(e) => setSingleExamSessionData(prev => ({ ...prev, customSubjectId: e.target.value }))}
                                                            required
                                                            className="w-full p-3 border border-stone-200 rounded-xl text-xs outline-none bg-stone-50 font-bold"
                                                        >
                                                            <option value="">בחרי מקצוע...</option>
                                                            {(activeUserData.subjects || []).map(s => (
                                                                <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <input 
                                                    type="text" 
                                                    placeholder="שם המבחן (למשל: בגרות באזרחות, מתכונת בפיזיקה)" 
                                                    value={singleExamSessionData.customExamName || ''} 
                                                    onChange={(e) => setSingleExamSessionData(prev => ({ ...prev, customExamName: e.target.value }))}
                                                    required 
                                                    className="w-full p-3.5 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-amber-400 font-bold"
                                                />
                                                <select 
                                                    value={singleExamSessionData.customSubjectId || ''} 
                                                    onChange={(e) => setSingleExamSessionData(prev => ({ ...prev, customSubjectId: e.target.value }))}
                                                    required
                                                    className="w-full p-3 border border-stone-200 rounded-xl text-xs outline-none bg-stone-50 font-bold"
                                                >
                                                    <option value="">בחרי מקצוע...</option>
                                                    {(activeUserData.subjects || []).map(s => (
                                                        <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        )}
                                    </div>

                                    {/* Session Title */}
                                    <div>
                                        <label className="text-xs font-bold mb-1.5 block text-stone-500 uppercase">כותרת המפגש / מה ללמוד?</label>
                                        <input 
                                            type="text" 
                                            value={singleExamSessionData.title}
                                            onChange={(e) => setSingleExamSessionData(prev => ({ ...prev, title: e.target.value }))}
                                            placeholder="למשל: ללמוד למבחן, חזרה על סיכומים..." 
                                            required 
                                            className="w-full p-3.5 border border-stone-200 rounded-xl text-sm outline-none bg-stone-50 focus:bg-white focus:border-amber-400 font-bold transition-all"
                                        />
                                        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                                            <span className="text-[11px] font-bold text-stone-400">קיצורים:</span>
                                            {(() => {
                                                const selectedEx = (activeUserData.exams || []).find(x => x.id === singleExamSessionData.examId);
                                                const nextNum = selectedEx ? getNextSessionNumberForExam(selectedEx.id, activeUserData.tasks) : 1;
                                                const exName = selectedEx ? (selectedEx.examName || 'מבחן') : (singleExamSessionData.customExamName || 'מבחן');
                                                const presets = [
                                                    `ללמוד למבחן: ${exName} - סשן ${nextNum}`,
                                                    `סשן ${nextNum} - חזרה על החומר וסיכומים`,
                                                    `סשן ${nextNum} - מרתון שאלות ותרגול`,
                                                    `סשן ${nextNum} - פתרון מבחן לדוגמה`
                                                ];
                                                return presets.map(preset => (
                                                    <button 
                                                        key={preset} 
                                                        type="button" 
                                                        onClick={() => setSingleExamSessionData(prev => ({ ...prev, title: preset }))}
                                                        className="text-[11px] bg-stone-100 hover:bg-amber-100 text-stone-600 hover:text-amber-800 px-2.5 py-1 rounded-lg transition-colors font-medium active:scale-95 border border-stone-200/60"
                                                    >
                                                        {preset}
                                                    </button>
                                                ));
                                            })()}
                                        </div>
                                    </div>

                                    {/* Flexible Time Info Notice */}
                                    <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200/80 flex items-center gap-3">
                                        <div className="w-9 h-9 rounded-xl bg-white border border-stone-200 flex items-center justify-center text-base shrink-0 shadow-2xs">
                                            🕒
                                        </div>
                                        <div className="text-xs text-stone-600">
                                            <b className="text-stone-800 font-bold block mb-0.5">זמן גמיש לחלוטין</b>
                                            לומדים מתי שרוצים – הסשן פתוח עד 00:00 בלילה שלפני המבחן.
                                        </div>
                                    </div>

                                    {/* 3 Points Highlight Box */}
                                    <div className="flex items-center justify-between p-3.5 bg-amber-50 rounded-2xl border border-amber-200">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xl">🏆</span>
                                            <div className="text-xs font-bold text-amber-950">ניקוד מובטח בסיום הסשן:</div>
                                        </div>
                                        <div className="text-sm font-black text-amber-800 bg-amber-200/80 px-2.5 py-1 rounded-xl shadow-2xs">
                                            +3 נקודות
                                        </div>
                                    </div>

                                    <button 
                                        type="submit" 
                                        className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white py-4 mt-2 rounded-2xl text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2"
                                    >
                                        <span>⚡</span>
                                        <span>יצירת סשן למידה (+3 נקודות)</span>
                                    </button>
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
                                                        date: exam.date,
                                                        time: exam.time || ''
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


                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                                            <div>
                                                <label className="text-xs font-bold text-stone-500 block mb-1.5 uppercase tracking-wide">שעת המבחן (אופציונלי)</label>
                                                <input 
                                                    type="time" 
                                                    value={examPlannerData.time || ''} 
                                                    onChange={e => setExamPlannerData({...examPlannerData, time: e.target.value})} 
                                                    className="w-full p-4 bg-white border border-stone-200 rounded-2xl text-sm outline-none font-medium focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all shadow-sm" 
                                                />
                                            </div>
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
                                    handleSaveSubject({ ...(editingSubject ? { id: editingSubject.id } : {}), name: e.target.name.value, color: e.target.color.value, emoji: e.target.emoji.value });
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
                                            {log.studyTimeRange && (
                                                <div className="mt-1.5 text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200/70 px-2 py-0.5 rounded-lg inline-flex items-center gap-1">
                                                    <span>⏳</span> משך למידה: {log.studyTimeRange}
                                                </div>
                                            )}
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
                        const displayStreak = liveData.taskStreak !== undefined ? liveData.taskStreak : (liveData.streak !== undefined ? liveData.streak : (activeFriend.streak || activeFriend.taskStreak || 0));
                        const displayPoints = liveData.totalPoints !== undefined ? liveData.totalPoints : (activeFriend.points || activeFriend.totalPoints || 0);
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
                                
                                <div className="grid grid-cols-4 gap-2 mb-6 relative z-10">
                                    <div className="bg-stone-50/80 p-2.5 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">מד רצף</div>
                                        <div className="text-rose-500 font-black text-lg">{displayStreak} 🔥</div>
                                    </div>
                                    <div className="bg-stone-50/80 p-2.5 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">השבוע</div>
                                        <div className="text-purple-600 font-black text-lg">{liveData.weeklyPoints !== undefined ? liveData.weeklyPoints : (activeFriend.weeklyPoints || 0)} ⚡</div>
                                    </div>
                                    <div className="bg-stone-50/80 p-2.5 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">סה"כ נק'</div>
                                        <div className="text-emerald-600 font-black text-lg">{displayPoints}</div>
                                    </div>
                                    <div className="bg-stone-50/80 p-2.5 rounded-2xl border border-stone-100 text-center">
                                        <div className="text-[10px] font-bold text-stone-400 mb-0.5 uppercase tracking-wide">הושלמו</div>
                                        <div className="text-blue-600 font-black text-lg">{completedCount} ✅</div>
                                    </div>
                                </div>

                                {/* ארון התגים של החברה */}
                                <div className="text-right bg-stone-50 p-4 rounded-2xl mb-5 border border-stone-200 relative z-10">
                                    <h4 className="font-bold text-sm text-stone-800 flex items-center justify-between mb-3">
                                        <span className="flex items-center gap-1.5">🎖️ ארון התגים של {activeFriend.name}:</span>
                                        <span className="text-[11px] text-stone-400 font-bold">{(liveData.badges || activeFriend.badges || []).length} תגים</span>
                                    </h4>
                                    {(() => {
                                        const fBadges = liveData.badges || activeFriend.badges || [];
                                        const earnedBadges = ALL_BADGES.map(badge => {
                                            const earned = fBadges.find(b => (typeof b === 'string' ? b === badge.id : b?.id === badge.id));
                                            return earned ? { ...badge, count: earned.count || 1 } : null;
                                        }).filter(Boolean);

                                        if (earnedBadges.length === 0) {
                                            return (
                                                <div className="text-xs text-stone-400 font-medium italic text-center py-3 bg-white rounded-xl border border-dashed border-stone-200">
                                                    עדיין אין תגים בארון, אבל היא בדרך לשם! ✨
                                                </div>
                                            );
                                        }

                                        return (
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                                {earnedBadges.map(b => (
                                                    <div key={b.id} className="bg-gradient-to-b from-amber-50 to-orange-50 border border-amber-200 p-2.5 rounded-xl text-center shadow-xs">
                                                        <div className="text-2xl mb-1 drop-shadow-sm">{b.icon}</div>
                                                        <div className="text-xs font-bold text-amber-950 leading-tight">
                                                            {b.title} {b.id === 'b_weekly_champ' && b.count > 1 && <span className="text-[10px] bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded-full">x{b.count}</span>}
                                                        </div>
                                                        <div className="text-[10px] text-stone-500 mt-0.5 line-clamp-1">{b.description}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })()}
                                </div>

                                <div className="text-right bg-stone-50 p-4 md:p-5 rounded-2xl mb-6 border border-stone-200 relative z-10">
                                    <div className="flex justify-between items-center mb-3">
                                        <h4 className="font-bold text-sm text-stone-800 flex items-center gap-2">
                                            <span>📋</span> משימות שפתוחות אצלה ({pendingTasks.length}):
                                        </h4>
                                    </div>
                                    
                                    {pendingTasks.length > 0 ? (
                                        <div className="space-y-2.5 max-h-60 overflow-y-auto custom-scrollbar pr-0.5">
                                            {pendingTasks.map((pt, i) => {
                                                const countdown = pt.dueDate ? getTaskCountdown(pt.dueDate, pt.dueTime) : null;
                                                const friendSubs = liveData.subjects || activeFriend.subjects || [];
                                                const fSub = friendSubs.find(s => s.id === pt.subjectId || s.name === pt.subjectId);
                                                const fSubName = fSub ? fSub.name : (pt.subjectName || '');
                                                const cleanF = cleanSubjectName(fSubName);
                                                const myMatch = (activeUserData.subjects || []).find(s => cleanSubjectName(s.name) === cleanF);

                                                return (
                                                    <div key={pt.id || i} className="bg-white p-3 rounded-xl border border-stone-200/70 shadow-xs flex flex-col gap-2">
                                                        <div className="flex items-start justify-between gap-2">
                                                            <div className="flex-1">
                                                                <div className="flex items-center gap-2 flex-wrap">
                                                                    <span className="font-bold text-stone-800 text-sm">{pt.title}</span>
                                                                    {fSubName && (
                                                                        <span className="text-[10px] bg-purple-50 text-purple-700 px-2 py-0.5 rounded-md font-bold border border-purple-100">
                                                                            {fSub?.emoji || '📚'} {fSubName}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {pt.lessonTopic && <div className="text-xs text-stone-400 mt-0.5 font-medium">נושא: {pt.lessonTopic}</div>}
                                                            </div>
                                                            <button 
                                                                onClick={() => handleCopyFriendTask(pt, fSubName)} 
                                                                className={`text-xs font-bold px-2.5 py-1.5 rounded-xl border transition-colors flex items-center gap-1 active:scale-95 shrink-0 ${
                                                                    myMatch 
                                                                        ? 'bg-purple-50 hover:bg-purple-100 text-purple-700 border-purple-200' 
                                                                        : 'bg-stone-100 hover:bg-stone-200 text-stone-400 border-stone-200'
                                                                }`}
                                                                title={myMatch ? `העתק למקצוע ${myMatch.name}` : `אין אצלך מקצוע בשם "${fSubName}"`}>
                                                                <IconCopy className="w-3.5 h-3.5" /> {myMatch ? 'העתק אליי' : 'אין מקצוע תואם'}
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
                        const isTaskDone = task.completed || !!task.completedAt || !!task.givenUp || (typeof taskLooksCompleted === 'function' && taskLooksCompleted(task));
                        const countdown = !isTaskDone && task.dueDate ? getTaskCountdown(task.dueDate, task.dueTime) : null;
                        const isLate = !isTaskDone && task.dueDate && task.dueTime ? (new Date() > new Date(`${task.dueDate}T${task.dueTime}`)) : false;

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
                                                {task.studyTimeRange && (
                                                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100">
                                                        ⏳ {task.studyTimeRange}
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
                                        {task.attachments && task.attachments.length > 0 && (
                                            <button 
                                                onClick={() => {
                                                    openAttachmentViewer(task);
                                                    setTaskActionsMenu(null);
                                                }}
                                                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-purple-50 hover:bg-purple-100 text-purple-900 border border-purple-200 transition-all font-bold text-sm active:scale-98 shadow-xs">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">🖼️</span>
                                                    <span>צפייה בצילומי לוח ודפי עבודה ({task.attachments.length})</span>
                                                </div>
                                                <span className="text-purple-700 bg-purple-200/70 px-2.5 py-0.5 rounded-md text-[11px] font-bold">פתיחה ↗</span>
                                            </button>
                                        )}

                                        <label className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-purple-50/50 hover:bg-purple-100 text-purple-900 border border-purple-200 transition-all font-bold text-sm active:scale-98 cursor-pointer">
                                            <input 
                                                type="file" 
                                                multiple 
                                                accept="image/*" 
                                                className="hidden" 
                                                onChange={async (e) => {
                                                    const files = Array.from(e.target.files || []);
                                                    if (files.length === 0) return;
                                                    setTaskActionsMenu(null);
                                                    await handleQuickAddAttachmentsToTask(task, files, 'board');
                                                    e.target.value = '';
                                                }} 
                                            />
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">📸</span>
                                                <span>הוספת צילום לוח מהשיעור</span>
                                            </div>
                                            <span className="text-purple-600 bg-purple-100 px-2 py-0.5 rounded text-[11px] font-bold">+ לוח</span>
                                        </label>

                                        {!task.isLessonLog && (
                                            <label className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-indigo-50/50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200 transition-all font-bold text-sm active:scale-98 cursor-pointer">
                                                <input 
                                                    type="file" 
                                                    multiple 
                                                    accept="image/*,application/pdf" 
                                                    className="hidden" 
                                                    onChange={async (e) => {
                                                        const files = Array.from(e.target.files || []);
                                                        if (files.length === 0) return;
                                                        setTaskActionsMenu(null);
                                                        await handleQuickAddAttachmentsToTask(task, files, 'homework');
                                                        e.target.value = '';
                                                    }} 
                                                />
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">📄</span>
                                                    <span>הוספת דף עבודה / ש.ב</span>
                                                </div>
                                                <span className="text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded text-[11px] font-bold">+ ש.ב</span>
                                            </label>
                                        )}
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

                                        {task.isFlexibleExamSession ? (
                                            <button 
                                                onClick={() => {
                                                    setTaskActionsMenu(null);
                                                    if (window.confirm('האם את בטוחה שברצונך למחוק את מפגש הלמידה הזה? (הפעולה ללא קנס וללא פגיעה ברצף)')) {
                                                        updateUserData(prev => {
                                                            const remainingTasks = (prev.tasks || []).filter(t => t.id !== task.id);
                                                            const updatedExams = (prev.exams || []).map(ex => {
                                                                if (task.examId && ex.id === task.examId) {
                                                                    const remainingForExam = remainingTasks.filter(rt => rt.examId === ex.id);
                                                                    const completedForExam = remainingTasks.filter(rt => rt.examId === ex.id && (rt.completed || rt.completedAt)).length;
                                                                    return {
                                                                        ...ex,
                                                                        sessionsCount: Math.max(0, remainingForExam.length),
                                                                        completedSessionsCount: completedForExam
                                                                    };
                                                                }
                                                                return ex;
                                                            });
                                                            return { ...prev, tasks: remainingTasks, exams: updatedExams };
                                                        });
                                                        showToast('מפגש הלמידה נמחק בהצלחה ✨', 'info');
                                                    }
                                                }}
                                                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-rose-50 hover:text-rose-700 text-stone-600 border border-stone-200 hover:border-rose-200 transition-all font-bold text-sm active:scale-98">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">🗑️</span>
                                                    <span>מחיקת מפגש הלמידה</span>
                                                </div>
                                                <span className="text-stone-400 text-xs">ללא קנס</span>
                                            </button>
                                        ) : !task.isExamPrep ? (
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

                    {examActionsMenu && (() => {
                        const exam = examActionsMenu;
                        const sub = activeUserData.subjects.find(s => s.id === exam.subjectId);
                        const subjectName = sub?.name || 'כללי';
                        const examCountdown = getExamCountdown(exam.date);
                        const isPast = exam.isArchived || (examCountdown && examCountdown.isPassed);

                        return (
                            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-xs animate-[fadeIn_0.15s_ease-out]">
                                <div className="bg-white rounded-3xl p-5 sm:p-6 w-full max-w-md shadow-2xl border border-stone-200 animate-[scaleUp_0.15s_ease-out] relative max-h-[90vh] overflow-y-auto custom-scrollbar">
                                    
                                    <div className="flex justify-between items-start mb-4 pb-3 border-b border-stone-100">
                                        <div className="flex-1 pr-1">
                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                <span className="text-xs font-bold px-2.5 py-0.5 rounded-lg bg-indigo-50 text-indigo-700">
                                                    {sub?.emoji || '📚'} {subjectName}
                                                </span>
                                                {examCountdown && (
                                                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border ${examCountdown.badgeClass}`}>
                                                        {examCountdown.text}
                                                    </span>
                                                )}
                                                {exam.grade && (
                                                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-800 border border-emerald-200">
                                                        ציון: {exam.grade} 🏆
                                                    </span>
                                                )}
                                            </div>
                                            <h3 className="font-bold text-lg text-stone-800 leading-snug">
                                                {exam.examName || 'מבחן'} ב{subjectName}
                                            </h3>
                                            <div className="text-xs text-stone-400 mt-0.5 font-medium flex items-center gap-2" dir="ltr">
                                                <span>📅 {new Date(exam.date).toLocaleDateString('he-IL')}</span>
                                                {exam.time && <span className="text-stone-600 font-bold">• ⏰ {exam.time}</span>}
                                                {(() => {
                                                    const examTasks = (activeUserData.tasks || []).filter(t => t.examId === exam.id && !t.givenUp);
                                                    const completedSessions = examTasks.filter(t => t.completed || t.completedAt).length;
                                                    const openSessions = examTasks.filter(t => !t.completed && !t.completedAt).length;
                                                    const totalSessions = Math.max(exam.sessionsCount || 0, completedSessions + openSessions);

                                                    if (completedSessions > 0) {
                                                        return (
                                                            <span dir="rtl" className="text-emerald-700 font-bold">
                                                                • {completedSessions}/{totalSessions} סשנים הושלמו {exam.targetHours ? `(${exam.targetHours} שעות)` : ''}
                                                            </span>
                                                        );
                                                    }
                                                    if (totalSessions > 0) {
                                                        return (
                                                            <span dir="rtl">• {totalSessions} מפגשים {exam.targetHours ? `(${exam.targetHours} שעות)` : 'מתוכננים'}</span>
                                                        );
                                                    }
                                                    return null;
                                                })()}
                                            </div>
                                        </div>
                                        <button onClick={() => setExamActionsMenu(null)} className="text-stone-400 bg-stone-100 hover:bg-stone-200 p-2 rounded-full active:scale-95 transition-colors">
                                            <IconX className="w-4 h-4"/>
                                        </button>
                                    </div>

                                    <div className="space-y-2">
                                        <button 
                                            onClick={() => {
                                                setActiveExamForGrade(exam);
                                                toggleModal('examGrade', true);
                                                setExamActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-emerald-50/70 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">✍️</span>
                                                <span>{exam.grade ? 'עריכת ציון המבחן' : 'הזנת ציון למבחן'}</span>
                                            </div>
                                            <span className="text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-md text-[11px] font-bold">
                                                {exam.grade ? `נוכחי: ${exam.grade}` : 'תיעוד הישג'}
                                            </span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                setEditingExam({
                                                    ...exam,
                                                    originalExamId: exam.id,
                                                    originalExamName: exam.examName,
                                                    originalDate: exam.date,
                                                    originalTime: exam.time || '',
                                                    originalSubjectId: exam.subjectId
                                                });
                                                setExamActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-amber-50/70 hover:bg-amber-100 text-amber-900 border border-amber-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">✏️</span>
                                                <span>עריכת פרטי מבחן (כותרת, תאריך ושעה)</span>
                                            </div>
                                            <span className="text-amber-700 bg-amber-100/70 px-2 py-0.5 rounded-md text-[11px] font-bold">
                                                שינוי פרטים
                                            </span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                setExamActionsMenu(null);
                                                handleResyncExamStudySessions(exam);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-indigo-50/80 hover:bg-indigo-100 text-indigo-950 border border-indigo-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">🔄</span>
                                                <span>סנכרון מחדש של שעות ותאריכי למידה</span>
                                            </div>
                                            <span className="text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-md text-[11px] font-bold">
                                                עדכון שעות ולו"ז
                                            </span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                setExamActionsMenu(null);
                                                handleOpenSingleSessionModal(exam);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 hover:from-amber-100 hover:to-orange-100 text-amber-950 border border-amber-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">⚡</span>
                                                <span>סשן למידה למבחן (+3 נקודות)</span>
                                            </div>
                                            <span className="text-amber-800 bg-amber-100 px-2 py-0.5 rounded-md text-[11px] font-black">
                                                ללא התחייבות
                                            </span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                setExamPlannerData({
                                                    step: 1,
                                                    existingExamId: exam.id,
                                                    subjectId: exam.subjectId,
                                                    examName: exam.examName || '',
                                                    date: exam.date,
                                                    hours: exam.targetHours || 5,
                                                    targetSessions: exam.sessionsCount || 3,
                                                    sessions: [],
                                                    remainingMinutes: 0
                                                });
                                                toggleModal('examPlanner', true);
                                                setExamActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-purple-50 hover:text-purple-800 text-stone-700 border border-stone-200 hover:border-purple-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">🎯</span>
                                                <span>{exam.sessionsCount ? 'עריכת תכנון למידה ומפגשים' : 'תכנון למידה חכם למבחן'}</span>
                                            </div>
                                            <span className="text-purple-600 bg-purple-50 px-2 py-0.5 rounded-md text-[11px] font-semibold">
                                                חלוקת לו"ז
                                            </span>
                                        </button>

                                        <button 
                                            onClick={() => {
                                                handleAddExamToCalendar(exam);
                                                setExamActionsMenu(null);
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
                                                handleGenerateExam(exam.subjectId);
                                                setExamActionsMenu(null);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-purple-50 hover:text-purple-800 text-stone-700 border border-stone-200 hover:border-purple-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">📄</span>
                                                <span>חוברת הכנה וסיכום A4 / PDF</span>
                                            </div>
                                            <span className="text-stone-400 text-xs">הפקה להדפסה</span>
                                        </button>

                                        {!isPast ? (
                                            <button 
                                                onClick={() => {
                                                    handleToggleArchiveExam(exam.id, true);
                                                    setExamActionsMenu(null);
                                                }}
                                                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-stone-100 text-stone-700 border border-stone-200 transition-all font-bold text-sm active:scale-98">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">📦</span>
                                                    <span>העברה לארכיון המבחנים</span>
                                                </div>
                                                <span className="text-stone-400 text-xs">מבחן שהסתיים</span>
                                            </button>
                                        ) : (
                                            <button 
                                                onClick={() => {
                                                    handleToggleArchiveExam(exam.id, false);
                                                    setExamActionsMenu(null);
                                                }}
                                                className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-stone-100 text-stone-700 border border-stone-200 transition-all font-bold text-sm active:scale-98">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xl">↩️</span>
                                                    <span>החזרה למבחנים קרובים</span>
                                                </div>
                                                <span className="text-stone-400 text-xs">לוח פעיל</span>
                                            </button>
                                        )}

                                        <button 
                                            onClick={() => {
                                                setExamActionsMenu(null);
                                                handleDeleteExam(exam.id);
                                            }}
                                            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-stone-50 hover:bg-rose-50 hover:text-rose-700 text-stone-600 border border-stone-200 hover:border-rose-200 transition-all font-bold text-sm active:scale-98">
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">🗑️</span>
                                                <span>מחיקת מבחן מהמערכת</span>
                                            </div>
                                            <span className="text-rose-500 text-xs">הסרה לצמיתות</span>
                                        </button>
                                    </div>

                                    <div className="mt-4 pt-3 border-t border-stone-100">
                                        <button 
                                            onClick={() => setExamActionsMenu(null)}
                                            className="w-full py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-2xl font-bold text-sm transition-colors active:scale-95">
                                            סגירה
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {viewingAttachment && (() => {
                        const { task, attachments, activeIndex, currentDataUrl, loading } = viewingAttachment;
                        const currentAtt = attachments[activeIndex] || attachments[0];
                        if (!currentAtt) return null;

                        const isPdf = currentAtt.type === 'application/pdf' || currentAtt.name?.toLowerCase().endsWith('.pdf');
                        const total = attachments.length;

                        const handleDeleteCurrentAttachment = async () => {
                            if (!window.confirm(`האם למחוק את הקובץ "${currentAtt.name}" לצמיתות?`)) return;
                            try {
                                await window.FileStorage.deleteAttachment(currentAtt.id);
                                const updatedAttachments = attachments.filter((_, i) => i !== activeIndex);
                                updateUserData(prev => ({
                                    ...prev,
                                    tasks: prev.tasks.map(t => t.id === task.id ? { ...t, attachments: updatedAttachments } : t)
                                }));
                                if (updatedAttachments.length === 0) {
                                    setViewingAttachment(null);
                                } else {
                                    const nextIdx = Math.max(0, activeIndex - 1);
                                    switchAttachmentIndex(nextIdx);
                                }
                                showToast('הקובץ נמחק בהצלחה', 'info');
                            } catch (e) {
                                console.error('Delete attachment error:', e);
                                showToast('שגיאה במחיקת הקובץ', 'error');
                            }
                        };

                        return (
                            <div className="fixed inset-0 z-[85] flex items-center justify-center p-2 sm:p-4 bg-stone-950/80 backdrop-blur-sm animate-[fadeIn_0.15s_ease-out]"
                                 onClick={() => setViewingAttachment(null)}>
                                <div className="bg-white rounded-3xl w-full max-w-4xl max-h-[95vh] shadow-2xl flex flex-col overflow-hidden border border-stone-200 animate-[scaleUp_0.15s_ease-out]"
                                     onClick={(e) => e.stopPropagation()}>
                                    
                                    {/* Header */}
                                    <div className="p-4 sm:p-5 border-b border-stone-100 flex items-center justify-between gap-3 bg-stone-50/70">
                                        <div className="flex items-center gap-3 overflow-hidden">
                                            <div className="w-10 h-10 rounded-2xl bg-purple-100 text-purple-700 flex items-center justify-center text-xl shrink-0">
                                                {isPdf ? '📄' : '🖼️'}
                                            </div>
                                            <div className="overflow-hidden">
                                                <div className="flex items-center gap-2">
                                                    <h3 className="font-bold text-base sm:text-lg text-stone-800 truncate" title={currentAtt.name}>
                                                        {currentAtt.name}
                                                    </h3>
                                                    {total > 1 && (
                                                        <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full font-bold shrink-0">
                                                            {activeIndex + 1} / {total}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-xs text-stone-400 truncate flex items-center gap-2">
                                                    <span>{task.title}</span>
                                                    <span>•</span>
                                                    <span>{window.FileStorage?.formatFileSize(currentAtt.size) || ''}</span>
                                                    {currentAtt.uploadedAt && (
                                                        <>
                                                            <span>•</span>
                                                            <span dir="ltr">{new Date(currentAtt.uploadedAt).toLocaleDateString('he-IL')}</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2 shrink-0">
                                            {currentDataUrl && (
                                                <>
                                                    <a 
                                                        href={currentDataUrl} 
                                                        download={currentAtt.name} 
                                                        className="px-3 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 active:scale-95" 
                                                        title="הורדת קובץ למכשיר"
                                                    >
                                                        <span>⬇️</span>
                                                        <span className="hidden sm:inline">הורדה</span>
                                                    </a>
                                                    <button 
                                                        type="button" 
                                                        onClick={() => {
                                                            try {
                                                                const arr = currentDataUrl.split(',');
                                                                const mime = arr[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
                                                                const bstr = atob(arr[1].replace(/\s/g, ''));
                                                                let n = bstr.length;
                                                                const u8arr = new Uint8Array(n);
                                                                while (n--) {
                                                                    u8arr[n] = bstr.charCodeAt(n);
                                                                }
                                                                const blob = new Blob([u8arr], { type: mime });
                                                                const blobUrl = URL.createObjectURL(blob);
                                                                window.open(blobUrl, '_blank');
                                                            } catch(e) {
                                                                window.open(currentDataUrl, '_blank');
                                                            }
                                                        }}
                                                        className="px-3 py-2 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 active:scale-95" 
                                                        title="פתיחה בלשונית חדשה במסך מלא"
                                                    >
                                                        <span>↗️</span>
                                                        <span className="hidden sm:inline">מסך מלא</span>
                                                    </button>
                                                </>
                                            )}
                                            <button 
                                                type="button" 
                                                onClick={handleDeleteCurrentAttachment}
                                                className="p-2 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors active:scale-95" 
                                                title="מחיקת קובץ זה מהמשימה"
                                            >
                                                <IconTrash className="w-4 h-4"/>
                                            </button>
                                            <button 
                                                type="button" 
                                                onClick={() => setViewingAttachment(null)}
                                                className="p-2 bg-stone-100 hover:bg-stone-200 text-stone-500 rounded-full transition-colors active:scale-95"
                                            >
                                                <IconX className="w-4 h-4"/>
                                            </button>
                                        </div>
                                    </div>

                                    {/* Content Body */}
                                    <div className="flex-1 overflow-auto p-3 md:p-6 flex flex-col items-center justify-start bg-stone-100/60 min-h-[380px] max-h-[75vh] custom-scrollbar">
                                        {loading ? (
                                            <div className="my-auto flex flex-col items-center gap-3 text-stone-400 animate-pulse">
                                                <div className="text-4xl animate-spin">⏳</div>
                                                <div className="text-sm font-bold">טוען קובץ מהענן...</div>
                                            </div>
                                        ) : !currentDataUrl ? (
                                            <div className="my-auto text-center p-8 text-stone-400">
                                                <div className="text-4xl mb-2">⚠️</div>
                                                <div className="font-bold text-stone-700 text-base">לא ניתן היה לטעון את תוכן הקובץ</div>
                                                <div className="text-xs mt-1 text-stone-500">ייתכן שהקובץ נמחק או שאין חיבור אינטרנט זמין.</div>
                                            </div>
                                        ) : isPdf ? (
                                            viewingAttachment.pdfPages && viewingAttachment.pdfPages.length > 0 ? (
                                                <div className="w-full max-w-3xl space-y-4 py-1">
                                                    <div className="text-center text-xs text-stone-500 font-medium pb-1 flex items-center justify-between px-2">
                                                        <span>📄 {currentAtt.name}</span>
                                                        <span className="bg-purple-100 text-purple-800 px-2.5 py-0.5 rounded-full font-bold">
                                                            {viewingAttachment.pdfPages.length} עמודים • גלילה מותאמת לנייד
                                                        </span>
                                                    </div>
                                                    {viewingAttachment.pdfPages.map(page => (
                                                        <div key={page.pageNumber} className="bg-white rounded-2xl p-2 md:p-4 shadow-sm border border-stone-200 text-center">
                                                            <div className="flex items-center justify-between text-xs text-stone-400 mb-2 px-1">
                                                                <span className="font-bold text-stone-600">עמוד {page.pageNumber} מתוך {page.totalPages}</span>
                                                            </div>
                                                            <img 
                                                                src={page.dataUrl} 
                                                                alt={`${currentAtt.name} - עמוד ${page.pageNumber}`} 
                                                                className="w-full rounded-xl object-contain border border-stone-100 shadow-xs" 
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="w-full h-full flex flex-col items-center justify-center p-2 my-auto">
                                                    <iframe 
                                                        src={currentDataUrl} 
                                                        title={currentAtt.name} 
                                                        className="w-full h-[65vh] rounded-2xl border border-stone-200 bg-white shadow-sm mb-3 hidden md:block"
                                                    />
                                                    <div className="md:hidden flex flex-col items-center justify-center p-6 bg-white rounded-2xl border border-stone-200 text-center w-full max-w-sm shadow-sm my-auto">
                                                        <div className="text-5xl mb-3">📄</div>
                                                        <div className="font-bold text-stone-800 text-base mb-1">{currentAtt.name}</div>
                                                        <div className="text-xs text-stone-500 mb-4">{window.FileStorage?.formatFileSize(currentAtt.size)}</div>
                                                        <a 
                                                            href={currentDataUrl} 
                                                            download={currentAtt.name} 
                                                            className="w-full py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl text-sm shadow-md flex items-center justify-center gap-2 active:scale-95"
                                                        >
                                                            <span>⬇️</span> פתיחה והורדת קובץ PDF
                                                        </a>
                                                    </div>
                                                </div>
                                            )
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center p-2 my-auto">
                                                <img 
                                                    src={currentDataUrl} 
                                                    alt={currentAtt.name} 
                                                    className="max-h-[68vh] max-w-full rounded-2xl object-contain shadow-lg border border-stone-200 bg-white"
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {/* Footer / Navigation for multiple attachments */}
                                    {total > 1 && (
                                        <div className="p-3 border-t border-stone-100 bg-white flex items-center justify-between gap-3">
                                            <button 
                                                type="button" 
                                                disabled={activeIndex === 0}
                                                onClick={() => switchAttachmentIndex(activeIndex - 1)}
                                                className="px-4 py-2 bg-stone-100 hover:bg-stone-200 disabled:opacity-30 disabled:pointer-events-none text-stone-700 rounded-xl text-xs font-bold transition-all active:scale-95"
                                            >
                                                ▶ הקודם
                                            </button>

                                            <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-2 max-w-[60%] custom-scrollbar">
                                                {attachments.map((att, i) => (
                                                    <button 
                                                        key={att.id || i}
                                                        onClick={() => switchAttachmentIndex(i)}
                                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                                                            i === activeIndex 
                                                                ? 'bg-purple-600 text-white shadow-sm' 
                                                                : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                                        }`}
                                                    >
                                                        {att.type === 'application/pdf' ? '📄' : '🖼️'} {i + 1}
                                                    </button>
                                                ))}
                                            </div>

                                            <button 
                                                type="button" 
                                                disabled={activeIndex === total - 1}
                                                onClick={() => switchAttachmentIndex(activeIndex + 1)}
                                                className="px-4 py-2 bg-stone-100 hover:bg-stone-200 disabled:opacity-30 disabled:pointer-events-none text-stone-700 rounded-xl text-xs font-bold transition-all active:scale-95"
                                            >
                                                הבא ◀
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })()}

                    {examPrintModal && (
                        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-[fadeIn_0.2s_ease-out]"
                             onClick={() => !isPreparingPrint && setExamPrintModal(null)}>
                            <div className="bg-white rounded-3xl p-6 md:p-8 max-w-lg w-full shadow-2xl border border-stone-100 max-h-[90vh] overflow-y-auto" 
                                 dir="rtl"
                                 onClick={(e) => e.stopPropagation()}>
                                {/* Header */}
                                <div className="flex items-center justify-between mb-5 border-b border-stone-100 pb-3">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-2xl bg-purple-50 text-purple-700 flex items-center justify-center text-xl font-bold">
                                            🖨️
                                        </div>
                                        <div>
                                            <h3 className="text-xl font-black text-stone-900">הפקת חוברת / הדפסה</h3>
                                            <p className="text-xs text-stone-500 font-medium">
                                                {(() => {
                                                    const sub = (activeUserData.subjects || []).find(s => s.id === examPrintModal.subjectId || s.name === examPrintModal.subjectId);
                                                    return sub ? `${sub.emoji || '📖'} ${sub.name}` : (examPrintModal.subjectId || 'כללי');
                                                })()}
                                            </p>
                                        </div>
                                    </div>
                                    <button 
                                        type="button"
                                        onClick={() => !isPreparingPrint && setExamPrintModal(null)}
                                        disabled={isPreparingPrint}
                                        className="text-stone-400 hover:text-stone-600 w-8 h-8 rounded-full hover:bg-stone-100 flex items-center justify-center transition-all text-lg font-bold"
                                    >
                                        ✕
                                    </button>
                                </div>

                                {/* Selection Options */}
                                <div className="space-y-3 mb-6">
                                    <div className="text-xs font-bold text-stone-700 mb-1">בחרי את פורמט ההדפסה הרצוי:</div>

                                    {/* Option 1: Regular */}
                                    <div 
                                        onClick={() => !isPreparingPrint && setExamPrintModal(prev => ({ ...prev, mode: 'regular' }))}
                                        className={`p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                                            examPrintModal.mode === 'regular' 
                                                ? 'border-purple-600 bg-purple-50/70 shadow-xs' 
                                                : 'border-stone-200 hover:border-stone-300 bg-stone-50/50'
                                        }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className={`w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0 ${
                                                examPrintModal.mode === 'regular' ? 'border-purple-600 bg-purple-600' : 'border-stone-300'
                                            }`}>
                                                {examPrintModal.mode === 'regular' && <div className="w-2 h-2 rounded-full bg-white"></div>}
                                            </div>
                                            <div>
                                                <div className="font-bold text-stone-900 text-sm flex items-center gap-1.5">
                                                    <span>📝 חוברת הכנה רגילה (טקסט וסיכום בלבד)</span>
                                                </div>
                                                <p className="text-xs text-stone-500 mt-1">
                                                    סילבוס, תרגילים קשים, יומן כותרות שיעורים, רשימת שיעורי בית, מבחנים קודמים וצ'ק-ליסט — קובץ קל, מהיר וממוקד (ללא תמונות וקבצים).
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Option 2: Lessons & Board Photos */}
                                    <div 
                                        onClick={() => !isPreparingPrint && setExamPrintModal(prev => ({ ...prev, mode: 'lessons' }))}
                                        className={`p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                                            examPrintModal.mode === 'lessons' 
                                                ? 'border-purple-600 bg-purple-50/70 shadow-xs' 
                                                : 'border-stone-200 hover:border-stone-300 bg-stone-50/50'
                                        }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className={`w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0 ${
                                                examPrintModal.mode === 'lessons' ? 'border-purple-600 bg-purple-600' : 'border-stone-300'
                                            }`}>
                                                {examPrintModal.mode === 'lessons' && <div className="w-2 h-2 rounded-full bg-white"></div>}
                                            </div>
                                            <div>
                                                <div className="font-bold text-stone-900 text-sm flex items-center gap-1.5">
                                                    <span>📸 יומן שיעורים וצילומי לוח בלבד</span>
                                                </div>
                                                <p className="text-xs text-stone-500 mt-1">
                                                    רק כותרות השיעורים, התאריכים, ההערות וצילומי הלוח מהכיתה (ללא שיעורי בית וללא נספחים).
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Option 3: All (Both Together) */}
                                    <div 
                                        onClick={() => !isPreparingPrint && setExamPrintModal(prev => ({ ...prev, mode: 'all' }))}
                                        className={`p-4 rounded-2xl border-2 cursor-pointer transition-all ${
                                            examPrintModal.mode === 'all' 
                                                ? 'border-purple-600 bg-purple-50/70 shadow-xs' 
                                                : 'border-stone-200 hover:border-stone-300 bg-stone-50/50'
                                        }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className={`w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center shrink-0 ${
                                                examPrintModal.mode === 'all' ? 'border-purple-600 bg-purple-600' : 'border-stone-300'
                                            }`}>
                                                {examPrintModal.mode === 'all' && <div className="w-2 h-2 rounded-full bg-white"></div>}
                                            </div>
                                            <div>
                                                <div className="font-bold text-stone-900 text-sm flex items-center gap-1.5">
                                                    <span>🌟 חוברת מקיפה + צילומי לוח (שניהם ביחד)</span>
                                                </div>
                                                <p className="text-xs text-stone-500 mt-1">
                                                    כל תוכן החוברת הרגילה (סילבוס, שיעורי בית, מבחנים) בתוספת צילומי הלוח מהכיתה מכל השיעורים.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Action Buttons */}
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setExamPrintModal(null)}
                                        disabled={isPreparingPrint}
                                        className="flex-1 py-3 px-4 rounded-xl text-stone-600 hover:bg-stone-100 font-bold text-sm transition-all border border-stone-200 cursor-pointer"
                                    >
                                        ביטול
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => prepareAndPrintExam(examPrintModal.subjectId, examPrintModal.mode)}
                                        disabled={isPreparingPrint}
                                        className="flex-2 py-3 px-6 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-sm shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                                    >
                                        {isPreparingPrint ? (
                                            <>
                                                <span className="animate-spin text-lg">⏳</span>
                                                <span>מכין חוברת להדפסה...</span>
                                            </>
                                        ) : (
                                            <>
                                                <span>🖨️</span>
                                                <span>הפקת חוברת להדפסה / שמירה כ-PDF</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

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

                    {editingExam && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-xs animate-[fadeIn_0.15s_ease-out]" dir="rtl">
                            <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border border-stone-200 animate-[scaleUp_0.15s_ease-out] relative">
                                <div className="flex justify-between items-center mb-5 pb-3 border-b border-stone-100">
                                    <div className="flex items-center gap-2.5">
                                        <span className="p-2.5 bg-amber-50 text-amber-600 rounded-2xl text-xl">✏️</span>
                                        <div>
                                            <h3 className="font-bold text-lg text-stone-800">עריכת פרטי מבחן</h3>
                                            <p className="text-xs text-stone-500">שינוי שם/כותרת, מקצוע, תאריך ושעה</p>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => setEditingExam(null)} 
                                        className="text-stone-400 bg-stone-100 hover:bg-stone-200 p-2 rounded-full transition-colors active:scale-95">
                                        <IconX className="w-4 h-4"/>
                                    </button>
                                </div>

                                <form onSubmit={(e) => {
                                    e.preventDefault();
                                    handleSaveEditedExam(editingExam);
                                }} className="space-y-4">
                                    <div>
                                        <label className="block text-xs font-bold text-stone-600 mb-1.5">מקצוע</label>
                                        <select
                                            value={editingExam.subjectId}
                                            onChange={(e) => setEditingExam({ ...editingExam, subjectId: e.target.value })}
                                            className="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:bg-white outline-none transition-all">
                                            {(activeUserData.subjects || []).map(sub => (
                                                <option key={sub.id} value={sub.id}>{sub.emoji} {sub.name}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-xs font-bold text-stone-600 mb-1.5">שם / כותרת המבחן</label>
                                        <input
                                            type="text"
                                            required
                                            value={editingExam.examName || ''}
                                            onChange={(e) => setEditingExam({ ...editingExam, examName: e.target.value })}
                                            placeholder="לדוגמה: מבחן אמצע, בגרות מועד א'..."
                                            className="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:bg-white outline-none transition-all"
                                        />
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-xs font-bold text-stone-600 mb-1.5">תאריך המבחן</label>
                                            <input
                                                type="date"
                                                required
                                                value={editingExam.date || ''}
                                                onChange={(e) => setEditingExam({ ...editingExam, date: e.target.value })}
                                                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:bg-white outline-none transition-all"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-stone-600 mb-1.5">שעת המבחן (אופציונלי)</label>
                                            <input
                                                type="time"
                                                value={editingExam.time || ''}
                                                onChange={(e) => setEditingExam({ ...editingExam, time: e.target.value })}
                                                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-3.5 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:bg-white outline-none transition-all"
                                            />
                                        </div>
                                    </div>

                                    {(() => {
                                        const openTasksCount = (activeUserData.tasks || []).filter(t => 
                                            ((t.examId && String(t.examId) === String(editingExam.id)) || 
                                             (t.isExamPrep && t.lessonTopic && (editingExam.originalExamName || editingExam.examName) && t.lessonTopic.includes(editingExam.originalExamName || editingExam.examName)) ||
                                             (t.isExamPrep && t.title && (editingExam.originalExamName || editingExam.examName) && t.title.includes(editingExam.originalExamName || editingExam.examName))) &&
                                            !t.completed && !t.completedAt
                                        ).length;

                                        if (openTasksCount === 0) return null;
                                        return (
                                            <div className="bg-indigo-50/80 border border-indigo-100 rounded-2xl p-3 text-xs text-indigo-900 leading-relaxed flex items-start gap-2.5">
                                                <span className="text-base shrink-0">⚡</span>
                                                <div>
                                                    <span className="font-bold block text-indigo-950">סנכרון שעות ותאריכים אוטומטי ({openTasksCount} מפגשים פתוחים)</span>
                                                    <span>שינוי התאריך יעדכן ויפזר מחדש את תאריכי ושעות הלמידה בחלונות הזמן הפנויים בלו"ז שלך עד המבחן.</span>
                                                </div>
                                            </div>
                                        );
                                    })()}

                                    <div className="flex gap-2.5 pt-3">
                                        <button
                                            type="button"
                                            onClick={() => setEditingExam(null)}
                                            className="flex-1 py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl font-bold text-sm transition-colors active:scale-95">
                                            ביטול
                                        </button>
                                        <button
                                            type="submit"
                                            className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-sm shadow-md hover:shadow-lg transition-all active:scale-95">
                                            שמירת שינויים 💾
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    )}

                    {isSyncDiagnosticsOpen && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/60 backdrop-blur-xs animate-[fadeIn_0.15s_ease-out]" dir="rtl">
                            <div className="bg-white rounded-3xl p-6 w-full max-w-lg shadow-2xl border border-stone-200 animate-[scaleUp_0.15s_ease-out] relative max-h-[90vh] overflow-y-auto custom-scrollbar">
                                <div className="flex justify-between items-center mb-4 pb-3 border-b border-stone-100">
                                    <div className="flex items-center gap-2.5">
                                        <div className={`w-9 h-9 rounded-2xl flex items-center justify-center text-lg ${
                                            syncState === 'synced' ? 'bg-emerald-100 text-emerald-700' :
                                            syncState === 'syncing' ? 'bg-amber-100 text-amber-700' :
                                            syncState === 'offline' ? 'bg-stone-100 text-stone-600' : 'bg-rose-100 text-rose-700'
                                        }`}>
                                            {syncState === 'synced' ? '🟢' :
                                             syncState === 'syncing' ? '🟡' :
                                             syncState === 'offline' ? '⚪' : '🔴'}
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-lg text-stone-800">בדיקת סנכרון ענן וחיבור</h3>
                                            <p className="text-xs text-stone-500">סטטוס חיבור בזמן אמת בין הטלפון למחשב</p>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => setIsSyncDiagnosticsOpen(false)} 
                                        className="text-stone-400 bg-stone-100 hover:bg-stone-200 p-2 rounded-full transition-colors active:scale-95">
                                        <IconX className="w-4 h-4"/>
                                    </button>
                                </div>

                                <div className="space-y-4">
                                    <div className={`p-4 rounded-2xl border ${
                                        syncState === 'synced' ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950' :
                                        syncState === 'syncing' ? 'bg-amber-50/70 border-amber-200 text-amber-950' :
                                        syncState === 'offline' ? 'bg-stone-50 border-stone-200 text-stone-800' :
                                        'bg-rose-50/70 border-rose-200 text-rose-950'
                                    }`}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="font-black text-sm">
                                                {syncState === 'synced' ? '✅ הסנכרון פועל בצורה מושלמת' :
                                                 syncState === 'syncing' ? '⏳ סנכרון מתבצע כעת מול הענן...' :
                                                 syncState === 'offline' ? '📴 עבודה במצב מקומי (Offline)' :
                                                 '⚠️ שגיאת הרשאות ענן (Firebase Permission Denied)'}
                                            </span>
                                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white/80 border">
                                                {syncState.toUpperCase()}
                                            </span>
                                        </div>
                                        <p className="text-xs leading-relaxed opacity-90">
                                            {syncState === 'synced' ? 'כל השינויים, המשימות והנקודות שמורים ומסונכרנים אוטומטית לענן וזמינים גם בטלפון וגם במחשב.' :
                                             syncState === 'syncing' ? 'מעביר נתונים עדכניים לענן ומושך שינויים ממכשירים אחרים...' :
                                             syncState === 'offline' ? 'הדפדפן אינו מחובר כרגע לאינטרנט. כל המידע והשינויים שלך נשמרים בזיכרון המקומי ויסונכרנו אוטומטית ברגע שהחיבור יחזור!' :
                                             'כל המידע שלך שמור ומאובטח במכשיר! השגיאה נובעת מסיום 30 ימי הטסט ב-Firebase. כדי לאפשר סנכרון דו-כיווני בין הטלפון למחשב, יש לעדכן את החוקים ב-Firebase Console.'}
                                        </p>
                                        {syncErrorDetails && (
                                            <div className="mt-2.5 p-2 bg-white/90 rounded-xl text-[11px] font-mono text-stone-600 border border-stone-200 overflow-x-auto text-left" dir="ltr">
                                                {syncErrorDetails}
                                            </div>
                                        )}
                                    </div>

                                    <button
                                        onClick={async () => {
                                            showToast('בודק חיבור ומסנכרן מול הענן... 🔄', 'info');
                                            await pushPendingSyncToCloud();
                                        }}
                                        disabled={syncState === 'syncing'}
                                        className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-2xl font-bold text-sm shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 active:scale-95">
                                        <span>🔄</span> סנכרן עכשיו ובדוק חיבור
                                    </button>

                                    <div className="bg-stone-50 rounded-2xl p-4 border border-stone-200 space-y-2.5 text-xs text-stone-700">
                                        <div className="font-bold text-stone-900 flex items-center justify-between">
                                            <span>🛠️ הגדרת חוקי גישה קבועים (Firebase Rules)</span>
                                            <a 
                                                href="https://console.firebase.google.com/project/loos-77484/firestore/rules" 
                                                target="_blank" 
                                                rel="noopener noreferrer"
                                                className="text-indigo-600 hover:underline font-bold flex items-center gap-1">
                                                פתיחת הקונסול ↗️
                                            </a>
                                        </div>
                                        <p className="text-[11px] text-stone-500 leading-normal">
                                            ב-Firebase נפתח את לשונית <b>Firestore Database</b> &gt; <b>Rules</b>, נדביק את החוקים הבאים ונלחץ <b>Publish</b>:
                                        </p>
                                        <div className="relative">
                                            <pre className="p-2.5 bg-stone-900 text-stone-100 rounded-xl text-[10px] font-mono overflow-x-auto text-left leading-relaxed" dir="ltr">
{`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if true;
    }
    match /task_attachments/{attachmentId} {
      allow read, write: if true;
    }
  }
}`}
                                            </pre>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    navigator.clipboard?.writeText(`rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{userId} {\n      allow read, write: if true;\n    }\n    match /task_attachments/{attachmentId} {\n      allow read, write: if true;\n    }\n  }\n}`);
                                                    showToast('חוקי הגישה הועתקו ללוח! 📋', 'success');
                                                }}
                                                className="absolute top-2 left-2 px-2 py-1 bg-stone-700 hover:bg-stone-600 text-white rounded text-[10px] font-bold active:scale-95">
                                                העתקה 📋
                                            </button>
                                        </div>
                                    </div>

                                    <div className="p-3 bg-purple-50/60 border border-purple-100 rounded-2xl flex items-start gap-2.5 text-xs text-purple-900">
                                        <span className="text-base shrink-0">🛡️</span>
                                        <div>
                                            <span className="font-bold">הגנת מידע כפולה: </span>
                                            <span>ההתקדמות, הסטריק, הנקודות והקבצים שלך מגובים באופן רציף גם בזיכרון המקומי של המכשיר וגם בגיבוי חירום מבודד, כך ששום נתון לא הולך לאיבוד.</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-5 pt-3 border-t border-stone-100">
                                    <button 
                                        onClick={() => setIsSyncDiagnosticsOpen(false)}
                                        className="w-full py-3 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-2xl font-bold text-sm transition-colors active:scale-95">
                                        סגירה
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                </div>
            );
        }


        class ErrorBoundary extends React.Component {
            constructor(props) {
                super(props);
                this.state = { hasError: false, error: null };
            }

            static getDerivedStateFromError(error) {
                return { hasError: true, error };
            }

            componentDidCatch(error, errorInfo) {
                console.error("StudyStreak caught error in ErrorBoundary:", error, errorInfo);
            }

            render() {
                if (this.state.hasError) {
                    return (
                        <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4 font-sans text-stone-800" dir="rtl">
                            <div className="bg-white max-w-md w-full p-6 md:p-8 rounded-3xl shadow-xl border border-stone-200 text-center space-y-4">
                                <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-2xl mx-auto flex items-center justify-center text-3xl">
                                    ⚠️
                                </div>
                                <h2 className="text-xl font-black text-stone-800">אופס! משהו השתבש</h2>
                                <p className="text-sm text-stone-500 leading-relaxed">
                                    התרחשה שגיאה בלתי צפויה בתצוגה, אך המידע שלך נשמר. לחצי על הכפתור למטה לרענון מהיר.
                                </p>
                                {this.state.error && (
                                    <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-600 font-mono text-left max-h-28 overflow-y-auto" dir="ltr">
                                        {this.state.error.message || String(this.state.error)}
                                    </div>
                                )}
                                <div className="pt-2 flex gap-3">
                                    <button 
                                        onClick={() => window.location.reload()} 
                                        className="flex-1 bg-stone-800 hover:bg-stone-900 text-white font-bold py-3.5 px-4 rounded-2xl text-sm transition-all active:scale-95 shadow-md">
                                        🔄 רענון האפליקציה
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                }
                return this.props.children;
            }
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        );
