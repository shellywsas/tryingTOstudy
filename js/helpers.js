const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];


        const getUserLevel = (points) => {
            if (points <= 50) return { title: 'תלמידה מתחילה', icon: '🌱' };
            if (points <= 150) return { title: 'צוערת בגרויות', icon: '🚀' };
            if (points <= 300) return { title: 'סיירת למידה', icon: '🕵️‍♀️' };
            if (points <= 600) return { title: 'מאסטר בלמידה', icon: '👑' };
            if (points <= 1000) return { title: 'אגדת מיונים', icon: '🦸‍♀️' };
            return { title: 'פרופסורית (Top 1%)', icon: '🎓' };
        };


        const cleanSubjectName = (str) => {
            if (!str) return '';
            return String(str)
                .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]/gu, '')
                .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
                .trim()
                .toLowerCase();
        };

        const getNextSaturday22PM = () => {
            const now = new Date();
            const d = now.getDay(); // 0 = Sun, ..., 6 = Sat
            const target = new Date(now);
            if (d === 6) {
                // If it's Saturday and before 22:00
                if (now.getHours() < 22) {
                    target.setHours(22, 0, 0, 0);
                    return target.getTime();
                }
            }
            const daysToAdd = (6 - d + 7) % 7 || 7;
            target.setDate(now.getDate() + daysToAdd);
            target.setHours(22, 0, 0, 0);
            return target.getTime();
        };

        const getLastSaturday22PM = (nowInput) => {
            const now = nowInput instanceof Date ? nowInput : new Date(nowInput || Date.now());
            const d = now.getDay();
            const target = new Date(now);
            if (d === 6) {
                if (now.getHours() < 22) {
                    target.setDate(now.getDate() - 7);
                    target.setHours(22, 0, 0, 0);
                    return target.getTime();
                } else {
                    target.setHours(22, 0, 0, 0);
                    return target.getTime();
                }
            }
            const daysBack = d + 1;
            target.setDate(now.getDate() - daysBack);
            target.setHours(22, 0, 0, 0);
            return target.getTime();
        };

        const getNextSaturdayNight = getNextSaturday22PM;
        const getLastSaturdayNight = getLastSaturday22PM;


        const timeToMins = (t) => {
            if (!t) return 0;
            const [h, m] = t.split(':').map(Number);
            return h * 60 + m;
        };


        const minsToTime = (m) => {
            const h = Math.floor(m / 60);
            const mins = m % 60;
            return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        };


        const calculateSpecificDueDate = (subject, givenDateStr) => {
            if (!subject || !subject.rules || subject.rules.length === 0) return null; 
            
            const givenDate = new Date(givenDateStr);
            const currentDay = givenDate.getDay();
            
            const rule = subject.rules.find(r => Number(r.assignDay) === currentDay);
            if (rule) {
                const targetDay = Number(rule.dueDay);
                let daysToAdd = (targetDay - currentDay + 7) % 7;
                if (daysToAdd === 0) daysToAdd = 7; 
                
                const resultDate = new Date(givenDate);
                resultDate.setDate(resultDate.getDate() + daysToAdd);
                return {
                    date: resultDate.toISOString().split('T')[0],
                    time: rule.dueTime || '22:00'
                };
            }
            return null; 
        };


        const calculateSmartWindows = (schoolEndTimeStr, anchors) => {
            if (!schoolEndTimeStr || schoolEndTimeStr === '00:00') return null;
            
            const schoolEndMins = timeToMins(schoolEndTimeStr);
            let currentMins = schoolEndMins + 45; 
            const endOfDayMins = timeToMins('22:00'); 


            const sortedAnchors = [...anchors].sort((a, b) => timeToMins(a.start) - timeToMins(b.start));
            let windows = [];


            for (let anchor of sortedAnchors) {
                const anchorStartMins = timeToMins(anchor.start);
                const anchorEndMins = timeToMins(anchor.end);
                const maxLearningEnd = anchorStartMins - 30;


                if (maxLearningEnd - currentMins >= 45) { 
                    windows.push({
                        start: minsToTime(currentMins),
                        end: minsToTime(maxLearningEnd),
                        reason: `זמן פנוי לפני ${anchor.title}`
                    });
                }
                currentMins = Math.max(currentMins, anchorEndMins + 30);
            }


            if (endOfDayMins - currentMins >= 45) {
                windows.push({
                    start: minsToTime(currentMins),
                    end: '22:00',
                    reason: 'חלון זמן בערב'
                });
            }
            return windows;
        };

        const getUpcomingFreeWindows = (scheduleSettings, dueDateStr, maxDays = 5) => {
            if (!scheduleSettings || scheduleSettings.length === 0) return [];
            const now = new Date();
            const currentMinsNow = now.getHours() * 60 + now.getMinutes();
            
            let daysLimit = maxDays;
            if (dueDateStr) {
                const due = new Date(dueDateStr);
                const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                if (diffDays > 0) daysLimit = Math.min(maxDays, diffDays + 1);
            }

            const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
            let resultWindows = [];

            for (let i = 0; i < daysLimit; i++) {
                const targetDate = new Date();
                targetDate.setDate(targetDate.getDate() + i);
                const dayIdx = targetDate.getDay();
                const dayPlan = scheduleSettings[dayIdx];
                if (!dayPlan) continue;

                const isToday = i === 0;
                const isFreeDay = !dayPlan.schoolEndTime;
                const rawWindows = (isFreeDay && (!dayPlan.anchors || dayPlan.anchors.length === 0))
                    ? [{ start: '09:00', end: '22:00', reason: 'יום חופשי מלא' }]
                    : calculateSmartWindows(dayPlan.schoolEndTime || '08:30', dayPlan.anchors || []);

                if (!rawWindows) continue;

                for (let w of rawWindows) {
                    const startM = timeToMins(w.start);
                    const endM = timeToMins(w.end);

                    if (isToday && endM <= currentMinsNow) continue;
                    let actualStartM = startM;
                    if (isToday && startM < currentMinsNow) {
                        actualStartM = currentMinsNow + 10;
                    }

                    if (endM - actualStartM >= 30) {
                        resultWindows.push({
                            id: 'win_' + i + '_' + actualStartM,
                            dateStr: targetDate.toISOString().split('T')[0],
                            dayName: isToday ? 'היום' : (i === 1 ? 'מחר' : `יום ${dayNames[dayIdx]}`),
                            start: minsToTime(actualStartM),
                            end: w.end,
                            durationMins: endM - actualStartM,
                            reason: w.reason || 'זמן פנוי לפי הלו״ז'
                        });
                    }
                }
            }
            return resultWindows;
        };

        const MOTIVATIONAL_TEMPLATES = [
            (sub, title, topic, winText, name) => `היי ${name || 'אלופה'}! 🌸 שמתי לב שיש לך עכשיו חלון פנוי מעולה בלו״ז (${winText}). זה בדיוק הזמן לתקתק את שיעורי הבית ב${sub}${topic ? ` בנושא "${topic}"` : ''}! 25 דקות פוקוס ואת חופשייה לכל הערב. קטן עלייך! 🚀`,
            (sub, title, topic, winText, name) => `תזכורת של אלופות 🏆: יש לך עכשיו זמן פנוי (${winText}). בואי ננצל אותו לסגור את "${title}" ב${sub}! תשמרי על ה-Streak ותרגישי הכי טוב שיש. מוזיקה טובה ומתחילים! ✨`,
            (sub, title, topic, winText, name) => `הייוש! ☕ טיפ קטן להמשך היום: הזמן הפנוי שלך (${winText}) בדיוק התחיל. במקום לדחות ללילה, שווה לשבת עכשיו על ${sub}${topic ? ` (${topic})` : ''} ולסיים עם זה ברוגע. את תודי לעצמך אחר כך! 🎯`,
            (sub, title, topic, winText, name) => `בוסט מוטיבציה קצר ⚡: פנויה עכשיו (${winText})? בואי נתקדם קצת ב${sub}! כל תרגיל שאת עושה עכשיו מוריד ממך לחץ ענק. יאללה, פוקוס מהיר וסיימת! 💪`,
            (sub, title, topic, winText, name) => `רק קפצתי להזכיר בנחמדות 🌟: "${title}" ב${sub} מחכה לך, ועכשיו זה חלון זמן מושלם (${winText}) לעשות את זה בלי הפרעות. מאמינה בך בטירוף! 📚`,
            (sub, title, topic, winText, name) => `היי ${name || ''}! ⏱️ 20 דקות עכשיו של ישיבה על ${sub}${topic ? ` בנושא ${topic}` : ''}, ואת עם ראש שקט לגמרי לכל שאר היום. שווה לנסות! 🔥`
        ];

        const getRandomMotivationalMessage = (sub, title, topic, winText, name) => {
            const randomIndex = Math.floor(Math.random() * MOTIVATIONAL_TEMPLATES.length);
            return MOTIVATIONAL_TEMPLATES[randomIndex](sub, title, topic, winText, name);
        };

        const ALL_BADGES = [
            { id: 'b_weekly_champ', icon: '👑', title: 'אלופת השבוע', description: 'זכייה במקום הראשון בתחרות הנקודות השבועית', reqType: 'weekly_champ', reqTarget: 1 },
            { id: 'b_exam_90', icon: '🏆', title: 'מצטיינת מבחנים', description: 'קיבלת ב-4 מבחנים מעל 90', reqType: 'exams_90_plus', reqTarget: 4 },
            { id: 'b_on_time', icon: '⏱️', title: 'חסינת איחורים', description: 'הגשת בזמן במשך שבועיים רצוף', reqType: 'streak_days', reqTarget: 14 },
            { id: 'b_weekly_20', icon: '⚡', title: 'טורבו', description: 'צברת מעל 20 נקודות בשבוע אחד', reqType: 'weekly_points', reqTarget: 20 },
            { id: 'b_fast_hw', icon: '💨', title: 'ספידי', description: 'הגשת 5 שיעורי בית בפחות מחצי מהזמן', reqType: 'fast_hw', reqTarget: 5 },
            { id: 'b_sync_study', icon: '🤝', title: 'שותפות לגורל', description: 'את וחברה השלמתן משימה ארוכה באותו יום', reqType: 'sync_study', reqTarget: 1 },
            { id: 'b_comeback', icon: '🔄', title: 'קאמבק של אלופות', description: 'איבדת רצף, ולא נשברת - הגשת משימה ביום שאחרי', reqType: 'comeback', reqTarget: 1 },
            { id: 'b_sprint', icon: '🏎️', title: 'עקיפה בסיבוב', description: 'עקפת חברה בנקודות ביום שישי לקראת סגירת השבוע', reqType: 'sprint', reqTarget: 1 },
        ];

        const ADMIN_CREDENTIALS = {
            usernames: ['admin', 'אדמין'],
            passwords: ['admin', 'אדמין']
        };


        const DEFAULT_USER_STATE = {
            password: '',
            name: 'תלמיד/ה',
            taskStreak: 0,
            longestStreak: 0,
            currentStreakStart: null,
            currentStreakEmojis: [],
            totalPoints: 0,
            weeklyPoints: 0,
            highestWeeklyPoints: 0, 
            nextWeeklyReset: getNextSaturdayNight(),
            subjects: [],
            tasks: [],
            scheduleSettings: [
                { day: 0, schoolEndTime: '', anchors: [] },
                { day: 1, schoolEndTime: '', anchors: [] },
                { day: 2, schoolEndTime: '', anchors: [] },
                { day: 3, schoolEndTime: '', anchors: [] },
                { day: 4, schoolEndTime: '', anchors: [] },
                { day: 5, schoolEndTime: '', anchors: [] },
                { day: 6, schoolEndTime: '', anchors: [] }
            ],
            pointsHistory: [],
            streakHistory: [],
            friends: [],
            exams: [],
            phoneNumber: '',
            parentPhoneNumber: '',
            parentPhoneNumber2: '',
            whatsappGateway: {
                instanceId: '',
                apiToken: '',
                host: 'https://api.green-api.com'
            },
            autoSendParentReport: true,
            lastWeeklyReportSentWeek: '',
            lastTaskRemindersSent: {},
            notifications: [],
            badges: [] 
        };

        const getTaskCountdown = (dueDateStr, dueTimeStr) => {
            if (!dueDateStr) return null;
            const timeStr = dueTimeStr || '23:59';
            const target = new Date(`${dueDateStr}T${timeStr}`);
            if (isNaN(target.getTime())) return null;

            const diffMs = target.getTime() - Date.now();
            if (diffMs <= 0) {
                const passedHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
                return {
                    isLate: true,
                    urgency: 'late',
                    badgeClass: 'bg-rose-100 text-rose-700 border-rose-200 font-bold',
                    text: passedHours < 24 ? (passedHours === 0 ? 'זמן ההגשה עבר עכשיו!' : `עבר לפני ${passedHours} שעות`) : `באיחור של ${Math.floor(passedHours / 24)} ימים`
                };
            }

            const diffMins = Math.floor(diffMs / (1000 * 60));
            const diffHours = Math.floor(diffMins / 60);
            const remMins = diffMins % 60;
            const diffDays = Math.floor(diffHours / 24);

            if (diffMins <= 60) {
                return {
                    isLate: false,
                    urgency: 'urgent',
                    badgeClass: 'bg-rose-500 text-white border-rose-600 font-black animate-pulse shadow-sm',
                    text: `דחוף! נותרו ${diffMins} דק' 🚨`
                };
            }

            if (diffHours < 6) {
                return {
                    isLate: false,
                    urgency: 'high',
                    badgeClass: 'bg-amber-100 text-amber-900 border-amber-300 font-bold',
                    text: `נותרו ${diffHours} שעות ו-${remMins} דק' ⏳`
                };
            }

            if (diffHours < 24) {
                return {
                    isLate: false,
                    urgency: 'medium',
                    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200 font-semibold',
                    text: `נותרו ${diffHours} שעות (היום!) ⏰`
                };
            }

            if (diffDays === 1) {
                return {
                    isLate: false,
                    urgency: 'normal',
                    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200 font-medium',
                    text: `למחר (עוד יום ו-${diffHours % 24} ש') 📅`
                };
            }

            return {
                isLate: false,
                urgency: 'low',
                badgeClass: 'bg-stone-100 text-stone-700 border-stone-200 font-medium',
                text: `נותרו עוד ${diffDays} ימים 🗓️`
            };
        };

        const getExamCountdown = (examDateStr, examTimeStr) => {
            if (!examDateStr) return null;
            const target = new Date(examDateStr + 'T' + (examTimeStr || '08:00'));
            const now = new Date();
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const targetDay = new Date(examDateStr + 'T00:00:00');
            const diffDays = Math.round((targetDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays < 0) {
                return { isPassed: true, text: 'התקיים', badgeClass: 'bg-stone-100 text-stone-500' };
            }
            if (diffDays === 0) {
                if (examTimeStr) {
                    const diffMs = target.getTime() - now.getTime();
                    if (diffMs > 0) {
                        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                        if (diffHours > 0) {
                            return { isPassed: false, isToday: true, text: `היום ב-${examTimeStr} (בעוד ${diffHours} ש') 🍀`, badgeClass: 'bg-emerald-500 text-white animate-pulse font-black' };
                        } else {
                            return { isPassed: false, isToday: true, text: `היום ב-${examTimeStr} (בעוד ${diffMins} דק') 🍀`, badgeClass: 'bg-emerald-500 text-white animate-pulse font-black' };
                        }
                    } else {
                        return { isPassed: true, text: 'התקיים היום', badgeClass: 'bg-stone-200 text-stone-700 font-bold' };
                    }
                }
                return { isPassed: false, isToday: true, text: 'היום! בהצלחה 🍀', badgeClass: 'bg-emerald-500 text-white animate-pulse font-black' };
            }
            if (diffDays === 1) {
                return { isPassed: false, text: examTimeStr ? `מחר ב-${examTimeStr}! ⏰` : 'מחר! ⏰', badgeClass: 'bg-amber-500 text-white font-bold' };
            }
            if (diffDays <= 7) {
                return { isPassed: false, text: `עוד ${diffDays} ימים!`, badgeClass: 'bg-purple-100 text-purple-800 border border-purple-200 font-bold' };
            }
            return { isPassed: false, text: `עוד ${diffDays} ימים`, badgeClass: 'bg-stone-50 text-stone-600 border border-stone-200' };
        };

        const syncExamStudyTasks = (examId, newDate, newName, newSubjectId, allTasks = [], scheduleSettings = [], options = {}) => {
            if (!examId || !newDate) return { updatedTasks: allTasks, updatedCount: 0 };

            const todayStr = new Date().toISOString().split('T')[0];
            const oldName = (options.oldName || '').trim();

            // 1. Calculate new eve date (day before the exam, or today if eve is before today)
            let newEveDate = newDate;
            const parts = newDate.split('-');
            if (parts.length === 3) {
                const y = parseInt(parts[0], 10);
                const m = parseInt(parts[1], 10) - 1;
                const d = parseInt(parts[2], 10);
                const dObj = new Date(y, m, d);
                dObj.setDate(dObj.getDate() - 1);
                const yStr = dObj.getFullYear();
                const mStr = String(dObj.getMonth() + 1).padStart(2, '0');
                const dStr = String(dObj.getDate()).padStart(2, '0');
                const calcEve = `${yStr}-${mStr}-${dStr}`;
                newEveDate = calcEve >= todayStr ? calcEve : newDate;
            }

            // 2. Identify all tasks belonging to this exam
            const isTaskForExam = (t) => {
                if (t.examId && String(t.examId) === String(examId)) return true;
                if (oldName && t.isExamPrep && t.lessonTopic && t.lessonTopic.includes(oldName)) return true;
                if (oldName && t.isExamPrep && t.title && t.title.includes(oldName)) return true;
                return false;
            };

            const uncompletedPrepTasks = [];
            allTasks.forEach(t => {
                if (isTaskForExam(t) && !t.completed && !t.completedAt) {
                    uncompletedPrepTasks.push(t);
                }
            });

            if (uncompletedPrepTasks.length === 0) {
                const updated = allTasks.map(t => {
                    if (!isTaskForExam(t)) return t;
                    return {
                        ...t,
                        examId: examId,
                        subjectId: newSubjectId || t.subjectId,
                        title: newName && oldName && oldName !== newName ? t.title.split(oldName).join(newName) : t.title,
                        lessonTopic: newName ? `הכנה למבחן: ${newName}` : t.lessonTopic
                    };
                });
                return { updatedTasks: updated, updatedCount: 0 };
            }

            // 3. Pre-calculate available smart windows between today and newEveDate
            const startDate = new Date();
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(newDate + 'T00:00:00');
            endDate.setHours(0, 0, 0, 0);
            
            const totalDaysAvailable = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
            const dayWindowsList = [];
            const nowTime = new Date();
            const currentMinsNow = nowTime.getHours() * 60 + nowTime.getMinutes();

            for (let i = 0; i < totalDaysAvailable; i++) {
                const curD = new Date();
                curD.setDate(curD.getDate() + i);
                const curDStr = curD.toISOString().split('T')[0];
                
                if (totalDaysAvailable > 1 && curDStr > newEveDate) continue;

                const dayOfWeek = curD.getDay();
                const dayPlan = (scheduleSettings || [])[dayOfWeek] || {};
                const isToday = i === 0;
                const isFreeDay = !dayPlan.schoolEndTime;
                
                const rawWindows = (isFreeDay && (!dayPlan.anchors || dayPlan.anchors.length === 0))
                    ? [{ start: '09:00', end: '22:00', reason: 'יום חופשי מלא' }]
                    : (typeof calculateSmartWindows === 'function' 
                        ? calculateSmartWindows(dayPlan.schoolEndTime || '08:30', dayPlan.anchors || []) 
                        : [{ start: '16:00', end: '21:00' }]);

                if (!rawWindows || rawWindows.length === 0) {
                    dayWindowsList.push({
                        dateStr: curDStr,
                        start: '16:00',
                        end: '18:00',
                        durationMins: 120
                    });
                    continue;
                }

                for (let w of rawWindows) {
                    const startM = typeof timeToMins === 'function' ? timeToMins(w.start) : 960;
                    const endM = typeof timeToMins === 'function' ? timeToMins(w.end) : 1080;
                    
                    if (isToday && endM <= currentMinsNow) continue;
                    let actualStartM = startM;
                    if (isToday && startM < currentMinsNow) {
                        actualStartM = currentMinsNow + 15;
                    }

                    if (endM - actualStartM >= 30) {
                        dayWindowsList.push({
                            dateStr: curDStr,
                            start: typeof minsToTime === 'function' ? minsToTime(actualStartM) : w.start,
                            end: w.end,
                            durationMins: endM - actualStartM
                        });
                    }
                }
            }

            if (dayWindowsList.length === 0) {
                dayWindowsList.push({
                    dateStr: newEveDate,
                    start: '16:00',
                    end: '18:00',
                    durationMins: 120
                });
            }

            const structuredTasks = uncompletedPrepTasks.filter(t => !t.isFlexibleExamSession);
            const taskWindowMap = new Map();

            if (structuredTasks.length > 0) {
                if (structuredTasks.length === 1) {
                    taskWindowMap.set(structuredTasks[0].id, dayWindowsList[dayWindowsList.length - 1]);
                } else if (dayWindowsList.length >= structuredTasks.length) {
                    const step = (dayWindowsList.length - 1) / (structuredTasks.length - 1);
                    structuredTasks.forEach((st, idx) => {
                        const winIdx = Math.min(dayWindowsList.length - 1, Math.round(idx * step));
                        taskWindowMap.set(st.id, dayWindowsList[winIdx]);
                    });
                } else {
                    structuredTasks.forEach((st, idx) => {
                        const winIdx = idx % dayWindowsList.length;
                        taskWindowMap.set(st.id, dayWindowsList[winIdx]);
                    });
                }
            }

            let updatedCount = 0;
            const updatedTasks = allTasks.map(t => {
                if (!isTaskForExam(t)) return t;

                if (t.completed || t.completedAt) {
                    return {
                        ...t,
                        examId: examId,
                        subjectId: newSubjectId || t.subjectId
                    };
                }

                updatedCount++;
                let updatedTask = {
                    ...t,
                    examId: examId,
                    subjectId: newSubjectId || t.subjectId
                };

                if (newName && oldName && oldName !== newName) {
                    if (updatedTask.title && updatedTask.title.includes(oldName)) {
                        updatedTask.title = updatedTask.title.split(oldName).join(newName);
                    } else if (updatedTask.title && updatedTask.title.startsWith('ללמוד למבחן')) {
                        const sessionSuffixMatch = updatedTask.title.match(/(-\s*סשן\s*\d+|\(סשן\s*\d+\))/);
                        const suffix = sessionSuffixMatch ? ` ${sessionSuffixMatch[0]}` : '';
                        updatedTask.title = `ללמוד למבחן: ${newName}${suffix}`;
                    }
                    updatedTask.lessonTopic = `הכנה למבחן: ${newName}`;
                } else if (newName && (!updatedTask.lessonTopic || !updatedTask.lessonTopic.includes(newName))) {
                    updatedTask.lessonTopic = `הכנה למבחן: ${newName}`;
                }

                if (updatedTask.isFlexibleExamSession) {
                    updatedTask.dueDate = newEveDate;
                    updatedTask.dueTime = '23:59';
                    if (!updatedTask.startTime) updatedTask.startTime = '16:00';
                } else {
                    const win = taskWindowMap.get(updatedTask.id);
                    if (win) {
                        updatedTask.dueDate = win.dateStr;
                        let dur = 90;
                        if (updatedTask.startTime && updatedTask.dueTime && typeof timeToMins === 'function') {
                            const prevDur = timeToMins(updatedTask.dueTime) - timeToMins(updatedTask.startTime);
                            if (prevDur >= 30) dur = prevDur;
                        }
                        const winStartM = typeof timeToMins === 'function' ? timeToMins(win.start) : 960;
                        const winEndM = typeof timeToMins === 'function' ? timeToMins(win.end) : 1080;
                        const taskDur = Math.min(dur, winEndM - winStartM);

                        updatedTask.startTime = win.start;
                        updatedTask.dueTime = typeof minsToTime === 'function' ? minsToTime(winStartM + taskDur) : win.end;
                    } else {
                        updatedTask.dueDate = newEveDate;
                    }
                }

                return updatedTask;
            });

            return { updatedTasks, updatedCount };
        };

        const formatPastExamDate = (examDateStr) => {
            if (!examDateStr) return '';
            try {
                const target = new Date(examDateStr);
                target.setHours(0, 0, 0, 0);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
                if (diffDays === 0) return 'התקיים היום';
                if (diffDays === 1) return 'התקיים אתמול';
                if (diffDays < 7) return `התקיים לפני ${diffDays} ימים`;
                if (diffDays < 14) return 'התקיים לפני שבוע';
                if (diffDays < 30) return `התקיים לפני ${Math.floor(diffDays / 7)} שבועות`;
                if (diffDays < 60) return 'התקיים לפני כחודש';
                return `התקיים ב-${target.toLocaleDateString('he-IL')}`;
            } catch (e) {
                return examDateStr;
            }
        };
