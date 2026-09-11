const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];


        const getUserLevel = (points) => {
            if (points <= 50) return { title: 'תלמידה מתחילה', icon: '🌱' };
            if (points <= 150) return { title: 'צוערת בגרויות', icon: '🚀' };
            if (points <= 300) return { title: 'סיירת למידה', icon: '🕵️‍♀️' };
            if (points <= 600) return { title: 'מאסטר בלמידה', icon: '👑' };
            if (points <= 1000) return { title: 'אגדת מיונים', icon: '🦸‍♀️' };
            return { title: 'פרופסורית (Top 1%)', icon: '🎓' };
        };


        const getNextSaturdayNight = () => {
            const now = new Date();
            const daysUntilSaturday = 6 - now.getDay();
            const nextSaturday = new Date(now);
            nextSaturday.setDate(now.getDate() + daysUntilSaturday);
            nextSaturday.setHours(23, 59, 59, 999);
            return nextSaturday.getTime();
        };


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
            { id: 'b_exam_90', icon: '🏆', title: 'מצטיינת מבחנים', description: 'קיבלת ב-4 מבחנים מעל 90', reqType: 'exams_90_plus', reqTarget: 4 },
            { id: 'b_on_time', icon: '⏱️', title: 'חסינת איחורים', description: 'הגשת בזמן במשך שבועיים רצוף', reqType: 'streak_days', reqTarget: 14 },
            { id: 'b_weekly_20', icon: '⚡', title: 'טורבו', description: 'צברת מעל 20 נקודות בשבוע אחד', reqType: 'weekly_points', reqTarget: 20 },
            { id: 'b_fast_hw', icon: '💨', title: 'ספידי', description: 'הגשת 5 שיעורי בית בפחות מחצי מהזמן', reqType: 'fast_hw', reqTarget: 5 },
            { id: 'b_sync_study', icon: '🤝', title: 'שותפות לגורל', description: 'את וחברה השלמתן משימה ארוכה באותו יום', reqType: 'sync_study', reqTarget: 1 },
            { id: 'b_comeback', icon: '🔄', title: 'קאמבק של אלופות', description: 'איבדת רצף, ולא נשברת - הגשת משימה ביום שאחרי', reqType: 'comeback', reqTarget: 1 },
            { id: 'b_sprint', icon: '🏎️', title: 'עקיפה בסיבוב', description: 'עקפת חברה בנקודות ביום שישי לקראת סגירת השבוע', reqType: 'sprint', reqTarget: 1 },
        ];


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

        const getExamCountdown = (examDateStr) => {
            if (!examDateStr) return null;
            const target = new Date(examDateStr);
            target.setHours(8, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays < 0) {
                return { isPassed: true, text: 'התקיים', badgeClass: 'bg-stone-100 text-stone-500' };
            }
            if (diffDays === 0) {
                return { isPassed: false, isToday: true, text: 'היום! בהצלחה 🍀', badgeClass: 'bg-emerald-500 text-white animate-pulse font-black' };
            }
            if (diffDays === 1) {
                return { isPassed: false, text: 'מחר! ⏰', badgeClass: 'bg-amber-500 text-white font-bold' };
            }
            if (diffDays <= 7) {
                return { isPassed: false, text: `עוד ${diffDays} ימים!`, badgeClass: 'bg-purple-100 text-purple-800 border border-purple-200 font-bold' };
            }
            return { isPassed: false, text: `עוד ${diffDays} ימים`, badgeClass: 'bg-stone-50 text-stone-600 border border-stone-200' };
        };
