/**
 * StudyStreak Pro - WhatsApp Messaging Service
 * Handles Israeli phone formatting, WhatsApp Gateway API (Green-API) integration,
 * automated student reminders, and weekly parent progress reports.
 */

const WhatsAppService = {
    /**
     * Formats Israeli phone numbers into international WhatsApp chatId format:
     * Examples:
     *   "0521234567" -> "972521234567@c.us"
     *   "052-1234567" -> "972521234567@c.us"
     *   "+972 52 123 4567" -> "972521234567@c.us"
     *   "972521234567" -> "972521234567@c.us"
     */
    formatPhoneToChatId(phone) {
        if (!phone) return null;
        let cleaned = String(phone).replace(/\D/g, ''); // strip all non-digits
        
        if (cleaned.startsWith('05')) {
            cleaned = '972' + cleaned.substring(1);
        } else if (cleaned.startsWith('5') && cleaned.length === 9) {
            cleaned = '972' + cleaned;
        } else if (cleaned.startsWith('97205')) {
            cleaned = '972' + cleaned.substring(4); // Keep the '5'!
        }
        
        if (cleaned.length < 10) return null;
        return `${cleaned}@c.us`;
    },

    /**
     * Formats phone number for direct wa.me link
     */
    formatPhoneForWaLink(phone) {
        if (!phone) return '';
        const chatId = this.formatPhoneToChatId(phone);
        if (chatId) {
            return chatId.replace('@c.us', '');
        }
        let cleaned = String(phone).replace(/\D/g, '');
        if (cleaned.startsWith('05')) {
            return '972' + cleaned.substring(1);
        }
        return cleaned;
    },

    /**
     * Creates a direct WhatsApp click-to-chat URL (fallback that always works on any phone/PC)
     */
    createDirectLink(phone, text) {
        const cleanNumber = this.formatPhoneForWaLink(phone);
        const encoded = encodeURIComponent(text);
        if (cleanNumber) {
            return `https://wa.me/${cleanNumber}?text=${encoded}`;
        }
        return `https://wa.me/?text=${encoded}`;
    },

    /**
     * Sends a message via WhatsApp Gateway (e.g. Green-API)
     */
    async sendMessage({ to, message, gatewayConfig }) {
        const chatId = this.formatPhoneToChatId(to);
        if (!chatId) {
            throw new Error('מספר הטלפון שהוזן אינו תקין (נא להזין מספר ישראלי תקין, למשל 0501234567)');
        }

        const instanceId = gatewayConfig?.instanceId?.trim();
        const apiToken = gatewayConfig?.apiToken?.trim();
        const host = gatewayConfig?.host?.trim() || 'https://api.green-api.com';

        // If gateway credentials are provided, call the API directly
        if (instanceId && apiToken) {
            const endpoint = `${host.replace(/\/+$/, '')}/waInstance${instanceId}/sendMessage/${apiToken}`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chatId: chatId,
                    message: message
                })
            });

            if (!response.ok) {
                const errJson = await response.json().catch(() => ({}));
                throw new Error(errJson.message || `שגיאה בשליחת וואטסאפ (${response.status})`);
            }

            const data = await response.json().catch(() => ({}));
            return { status: 'sent_gateway', data };
        } else {
            // If no gateway is configured yet, open direct link as smooth fallback
            const directUrl = this.createDirectLink(to, message);
            window.open(directUrl, '_blank');
            return { status: 'opened_link', fallback: true, url: directUrl };
        }
    },

    /**
     * Generates a warm, proud weekly progress summary for parents
     */
    generateParentReportText(studentName, reportData) {
        const name = studentName || 'התלמיד/ה';
        const start = reportData?.startDate || '';
        const end = reportData?.endDate || '';
        const completedHW = reportData?.completedHW || [];
        const examPrep = reportData?.examPrepDone || [];
        const exams = reportData?.thisWeekExams || [];
        const points = reportData?.totalPointsGained || 0;
        const streak = reportData?.currentStreak !== undefined ? Number(reportData.currentStreak) : 0;

        let hwDetails = '';
        if (completedHW.length > 0) {
            hwDetails = completedHW.map(h => {
                let sName = h.subjectName;
                if (!sName && reportData?.subjects) {
                    const found = reportData.subjects.find(s => s.id === h.subjectId || s.name === h.subjectId);
                    if (found) sName = found.name;
                }
                if (!sName) sName = h.subject || 'כללי';
                const durStr = h.studyTimeRange ? ` [⏳ ${h.studyTimeRange}]` : '';
                return `  • ${h.title} (${sName})${durStr}`;
            }).slice(0, 10).join('\n');
            if (completedHW.length > 10) hwDetails += `\n  • ועוד ${completedHW.length - 10} משימות נוספות!`;
        } else {
            hwDetails = '  (לא היו משימות שהוגשו השבוע)';
        }

        let examDetails = '';
        if (examPrep.length > 0) {
            examDetails = examPrep.map(e => `  • סשן הכנה: ${e.title}`).slice(0, 5).join('\n');
        }

        const streakLine = streak > 0 
            ? `  🔥 רצף משימות פעיל: ${streak} ימים ברצף! כל הכבוד!` 
            : `  🔥 רצף משימות: מתחילים מחדש רצף חדש ומנצח השבוע! 💪`;

        return `שלום להורים של ${name}! 🌸\n` +
               `הנה דוח הלמידה וההשקעה השבועי של ${name} מתוך אפליקציית StudyStreak Pro 📚✨\n` +
               `📅 שבוע: ${start} - ${end}\n\n` +
               `📊 סיכום ההישגים השבוע:\n` +
               `  ✅ משימות ושיעורי בית שהושלמו: ${completedHW.length}\n` +
               (() => {
                   const h = reportData?.totalStudyHours > 0 ? reportData.totalStudyHours : 0;
                   if (h > 0) {
                       return `  ⏳ שעות למידה שתועדו השבוע: ${h} שעות מתועדות\n` +
                              `     *(לתשומת לבכם: מדובר בשעות שסומנו במשימות; לא כל זמן הלמידה נמדד ונרשם בשעות)*\n`;
                   } else {
                       return `  ⏳ שעות למידה שתועדו השבוע: לא נרשמו שעות (שעות נרשמות כאשר בוחרים לתעד זמן במשימה)\n`;
                   }
               })() +
               (examPrep.length > 0 ? `  🎯 סשנים של הכנה למבחנים: ${examPrep.length}\n` : '') +
               `  ⭐ נקודות שנצברו השבוע: ${points} נק'\n` +
               `${streakLine}\n\n` +
               `📝 פירוט המשימות שבוצעו השבוע:\n${hwDetails}\n` +
               (examDetails ? `\n🎯 הכנה למבחנים:\n${examDetails}\n` : '') +
               `\nכל הכבוד על ההשקעה, הלמידה וההתמדה! המשך שבוע מוצלח ומלא הישגים 🍀\n` +
               `הופק ע"י StudyStreak Pro ✨`;
    },

    /**
     * Generates an automated motivational reminder text for students.
     * Supports both an options object and positional arguments.
     */
    generateStudentReminderText(optsOrName, subjectName, taskTitle, topic, timeWindowText) {
        let name = 'שלי';
        let subj = 'כללי';
        let title = 'שיעורי בית';
        let top = '';
        let win = 'עכשיו';

        if (typeof optsOrName === 'object' && optsOrName !== null) {
            name = optsOrName.studentName || 'שלי';
            subj = optsOrName.subjectName || 'כללי';
            title = optsOrName.taskTitle || 'שיעורי בית';
            top = optsOrName.topic || optsOrName.lessonTopic || '';
            win = optsOrName.freeSlotText || optsOrName.timeWindowText || (optsOrName.dueDate ? `עד ${optsOrName.dueDate} ${optsOrName.dueTime || ''}` : 'בזמן הפנוי שלך');
        } else {
            name = optsOrName || 'שלי';
            subj = subjectName || 'כללי';
            title = taskTitle || 'שיעורי בית';
            top = topic || '';
            win = timeWindowText || 'עכשיו';
        }

        if (typeof getRandomMotivationalMessage === 'function') {
            return getRandomMotivationalMessage(subj, title, top, win, name);
        }
        return `היי ${name}! תזכורת חמה לשיעורי הבית ב-${subj}: "${title}". זמן מעולה להקדיש לזה קצת תשומת לב (${win}) 💪✨`;
    },

    /**
     * Generates a single, polite, combined reminder digest when a student has multiple upcoming tasks.
     * Prevents spamming multiple WhatsApp messages at once.
     */
    generateCombinedStudentReminderText(studentName, tasks = [], subjects = []) {
        const name = studentName || 'שלי';
        if (!tasks || tasks.length === 0) {
            return `היי ${name}! 🌸 זמן מעולה ללמידה קצרה ושמירה על הרצף! 💪✨`;
        }
        if (tasks.length === 1) {
            const task = tasks[0];
            const sub = subjects.find(s => s && s.id === task.subjectId);
            return this.generateStudentReminderText({
                studentName: name,
                subjectName: sub ? sub.name : 'כללי',
                taskTitle: task.title,
                dueDate: task.dueDate,
                dueTime: task.dueTime,
                freeSlotText: 'בזמן הפנוי שלך היום'
            });
        }

        const todayStr = (() => {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const tomorrowStr = (() => {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();

        // מציגים לכל היותר 3 משימות הכי דחופות כדי לא להעמיס בבת אחת!
        const displayTasks = tasks.slice(0, 3);
        const taskLines = displayTasks.map((t, idx) => {
            const sub = subjects.find(s => s && s.id === t.subjectId);
            const sName = sub ? sub.name : (t.subject || 'כללי');
            let whenStr = '';
            if (t.dueDate) {
                if (t.dueDate === todayStr) whenStr = `היום${t.dueTime ? ' עד ' + t.dueTime : ''}`;
                else if (t.dueDate === tomorrowStr) whenStr = `מחר${t.dueTime ? ' עד ' + t.dueTime : ''}`;
                else {
                    try {
                        const [y, m, d] = t.dueDate.split('-');
                        whenStr = `${d}/${m}${t.dueTime ? ' ' + t.dueTime : ''}`;
                    } catch(e) { whenStr = t.dueDate; }
                }
            }
            const timeInfo = whenStr ? ` (📅 ${whenStr})` : '';
            return `  ${idx + 1}. ${t.title} [${sName}]${timeInfo}`;
        }).join('\n');

        const moreCount = tasks.length - displayTasks.length;
        const moreLine = moreCount > 0 ? `\n  • (ועוד ${moreCount} משימות נוספות שממתינות לך בהמשך באפליקציה)` : '';

        return `היי ${name}! 🌸 תזכורת חמה ומעודדת ללמידה מ-StudyStreak Pro ✨\n` +
               `יש לך ${tasks.length} משימות לביצוע:\n` +
               `${taskLines}${moreLine}\n\n` +
               `כל התקדמות קטנה שומרת על הרצף שלך ומקרבת אותך למטרה! בהצלחה רבה 💪🍀`;
    }
};

if (typeof window !== 'undefined') {
    window.WhatsAppService = WhatsAppService;
}
