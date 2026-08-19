(function () {
    const STORE = 'tenderflow.lang';
    const SUPPORTED = ['en', 'ar'];

    const STRINGS = {
        en: {
            switchTo: 'العربية',
            switchToAria: 'اعرض هذه الصفحة بالعربية',

            pageTitle: 'Invitation to Quote',
            mastheadNote: 'Invitation to quote',
            loading: 'Opening your invitation…',
            footer: "This link was addressed to your company. If you weren't expecting it, please contact the purchasing team who sent it.",

            noDeadline: 'no closing date set',
            closes: (d) => `closes ${d}`,
            addressedTo: (c) => `This invitation is addressed to ${c}. Please don't forward it — the link files a quotation in your name.`,
            docsRequired: 'Documents required:',
            docsRequiredTail: "There is an upload box for each of them further down — a quotation can't be sent without them.",

            noItemised: 'No itemised list was attached to this tender. Describe what you are offering in the offer below.',
            asking: "What we're asking for",
            itemCount: (n) => `${n} item${n === 1 ? '' : 's'}`,
            thNum: '#',
            thItem: 'Item',
            thSpec: 'Specification',
            thNotes: 'Notes',
            thQuantity: 'Quantity',

            noOffersTitle: 'No offers yet',
            noOffersBody: "An offer is one complete way of answering this tender. Tick the items you can supply, add anything you're proposing instead, and save it. Add a second offer if you have an alternative worth pricing.",
            yourOffers: 'Your offers',
            savedNothingSent: (n) => `${n} saved · nothing has been sent yet`,
            nothingSaved: 'Nothing saved yet',
            addOffer: 'Add an offer',

            offerLabel: (n) => `Offer ${n}`,
            coverItems: (a, b) => `${a} of ${b} requested item${b === 1 ? '' : 's'}`,
            coverSubs: (n) => `${n} substitute${n === 1 ? '' : 's'}`,
            coverExtras: (n) => `${n} extra${n === 1 ? '' : 's'}`,
            nothingPriced: 'nothing priced',
            edit: 'Edit',
            removeAria: (l) => `Remove ${l}`,

            docsTitle: 'Documents we need from you',
            docsHint: "All of them, or the quotation can't be sent. PDF, image or office file — whatever you have.",
            uploadAria: (d) => `Upload ${d}`,
            stillToAttach: (list) => `Still to attach: ${list}.`,

            sendTitle: 'Send your quotation',
            sendNotice: "Nothing above has reached us yet. Once you send, your quotation is sealed and can't be changed — please check your prices first.",
            depositLabel: 'Deposit / advance required',
            depositSuffix: '% of the offer total',
            depositHint: 'A percentage, not an amount — it applies to whichever offer is accepted. Enter 0 if none is required.',
            notesLabel: 'Anything else we should know',
            notesPlaceholder: 'Delivery time, warranty, payment terms',
            countedSome: (n, m) => `${n} offer${n === 1 ? '' : 's'}, from ${m}`,
            countedNone: 'Add an offer before sending',
            send: 'Send quotation',
            sending: 'Sending…',

            editingTitle: (l) => `Editing ${l}`,
            newOfferTitle: (n) => `New offer (${n})`,
            draftNote: 'Saved on this device only until you send the quotation',
            optionNameLabel: 'A name for this option',
            optional: '(optional)',
            optionNamePlaceholder: 'e.g. Original brand, or Budget alternative',
            optionNameHint: "Shown to the people comparing offers. Please don't put your company name here — offers are compared without knowing whose they are.",

            sectionAsked: 'Items we asked for',
            ledeAsked1: "Tick anything you can supply and the details are filled in for you — you only enter a quantity and your unit price. Leave the rest unticked. The quantity is yours to set in either direction: <strong>fewer</strong> than we asked for is a perfectly good answer (two of a requested three, and we source the rest elsewhere), and <strong>more</strong> is fine too if that's how it comes — a box of ten, or a spare thrown in.",
            ledeAsked2: "Enter <strong>0</strong> as the price for anything you're giving away: a case with the laptop, a bundled accessory, a sample. Please don't leave a price box empty, though — a blank isn't read as free.",
            thCanSupply: 'Can supply',
            thAskedFor: 'Asked for',
            thQtyCan: 'Qty you can supply',
            thUnitPrice: 'Unit price',
            thLineTotal: 'Line total',
            nothingItemised: 'Nothing was itemised on this tender.',

            sectionInstead: "Anything you're offering instead",
            ledeInstead: "Only for what isn't on the list above — a substitute for something you don't stock, a bundled extra, or a gift you're including. Type these in yourself and say which line they stand in for — the numbers match the list at the top of this page, so two rows with the same name stay apart. Price a giveaway at 0 and it shows on the quotation without adding to the total.",
            thStandsIn: 'Stands in for',
            thQty: 'Qty',
            thUnit: 'Unit',
            thRemove: 'Remove',
            addOwnItem: 'Add an item of your own',
            offerNotesLabel: 'Notes on this offer',
            offerNotesPlaceholder: "Lead time, warranty, why you're proposing a substitute",
            offerTotal: 'Offer total',
            cancel: 'Cancel',
            saveChanges: 'Save changes',
            saveOffer: 'Save offer',

            noSpec: 'no specification given',
            extraNothing: 'Extra — nothing on the list',
            insteadOf: (n, name) => `instead of #${n} ${name}`,
            phWhatOffering: "What you're offering",
            phMakeModel: 'Make, model, spec',
            phUnit: 'pcs',
            ariaItemName: 'Item name',
            ariaSpec: 'Specification',
            ariaReplaces: 'What this replaces',
            ariaQty: 'Quantity',
            ariaUnit: 'Unit',
            ariaUnitPrice: 'Unit price',
            ariaRemoveRow: 'Remove this row',
            ariaCanSupply: (name) => `I can supply ${name}`,
            ariaHowMany: (name) => `How many ${name} you can supply`,
            ariaUnitPriceFor: (name) => `Unit price for ${name}`,

            needQtyPrice: (list) => `Needs a quantity and a price (enter 0 if it's free): ${list}.`,
            yourOwnItem: (i) => `your own item ${i}`,
            tickAtLeastOne: 'Tick at least one item, or add one of your own, before saving.',
            savedOver: (list) => `Offer saved. Note you've quoted more than we asked for on: ${list}.`,
            savedOk: 'Offer saved. Nothing is sent until you send the quotation.',
            confirmRemove: (l) => `Remove ${l}? This can't be undone.`,

            addAtLeastOne: 'Add at least one offer before sending.',
            depositRange: 'The deposit is a percentage, so it has to be between 0 and 100.',
            offerEmpty: (l) => `${l} has nothing priced in it. Edit or remove it.`,
            submitFailed: 'Your quotation could not be submitted.',
            receivedTitle: 'Quotation received',
            receivedBody: (n, serial) => `Thank you. Your ${n} offer${n === 1 ? '' : 's'} for ${serial} ${n === 1 ? 'has' : 'have'} been recorded and can no longer be changed. The purchasing team will be in touch.`,

            nothingToOpen: 'Nothing to open here',
            nothingToOpenBody: 'This page needs the invitation link that was sent to you. Please open the link from your email rather than typing the address by hand.',
            linkInvalid: "This link isn't valid",
            linkInvalidBody: 'It may have been withdrawn, or the address may have been copied incompletely. Please get in touch with the purchasing team who sent it.',
            docTitle: (serial) => `Quote — ${serial}`,
            formClosed: 'This form is closed',
            formClosedBody: 'This tender is not accepting quotations.',
            pickedUp: (n) => `Picked up ${n} unsent offer${n === 1 ? '' : 's'} from your last visit.`,
        },

        ar: {
            switchTo: 'English',
            switchToAria: 'View this page in English',

            pageTitle: 'دعوة لتقديم عرض سعر',
            mastheadNote: 'دعوة لتقديم عرض سعر',
            loading: 'جارٍ فتح الدعوة…',
            footer: 'أُرسل هذا الرابط إلى شركتكم. إذا لم تكونوا تتوقعونه، يُرجى التواصل مع فريق المشتريات الذي أرسله.',

            noDeadline: 'لم يُحدَّد موعد إغلاق',
            closes: (d) => `يُغلق ${d}`,
            addressedTo: (c) => `هذه الدعوة موجَّهة إلى ${c}. يُرجى عدم إعادة توجيهها — فالرابط يسجّل عرض سعر باسمكم.`,
            docsRequired: 'المستندات المطلوبة:',
            docsRequiredTail: 'يوجد حقل رفع لكلٍّ منها أسفل الصفحة — ولا يمكن إرسال عرض السعر بدونها.',

            noItemised: 'لم تُرفَق قائمة تفصيلية بهذه المناقصة. يُرجى وصف ما تعرضونه في العرض أدناه.',
            asking: 'ما نطلبه',
            itemCount: (n) => `عدد البنود: ${n}`,
            thNum: '#',
            thItem: 'البند',
            thSpec: 'المواصفات',
            thNotes: 'ملاحظات',
            thQuantity: 'الكمية',

            noOffersTitle: 'لا توجد عروض بعد',
            noOffersBody: 'العرض هو طريقة كاملة واحدة للإجابة على هذه المناقصة. حدِّدوا البنود التي يمكنكم توريدها، وأضيفوا ما تقترحونه بديلًا عنها، ثم احفظوه. وأضيفوا عرضًا ثانيًا إن كان لديكم بديل يستحق التسعير.',
            yourOffers: 'عروضكم',
            savedNothingSent: (n) => `عدد المحفوظ: ${n} · لم يُرسَل شيء بعد`,
            nothingSaved: 'لم يُحفظ شيء بعد',
            addOffer: 'أضِف عرضًا',

            offerLabel: (n) => `العرض ${n}`,
            coverItems: (a, b) => `${a} من ${b} من البنود المطلوبة`,
            coverSubs: (n) => `عدد البدائل: ${n}`,
            coverExtras: (n) => `عدد الإضافات: ${n}`,
            nothingPriced: 'لا يوجد تسعير',
            edit: 'تعديل',
            removeAria: (l) => `حذف ${l}`,

            docsTitle: 'المستندات المطلوبة منكم',
            docsHint: 'جميعها مطلوبة، وإلا تعذَّر إرسال عرض السعر. ملف PDF أو صورة أو ملف مكتبي — أي صيغة متاحة لديكم.',
            uploadAria: (d) => `رفع ${d}`,
            stillToAttach: (list) => `ما زال يلزم إرفاق: ${list}.`,

            sendTitle: 'أرسِلوا عرض السعر',
            sendNotice: 'لم يصلنا شيء مما سبق بعد. وبمجرد الإرسال يُختَم عرض السعر ولا يمكن تعديله — يُرجى مراجعة أسعاركم أولًا.',
            depositLabel: 'الدفعة المقدَّمة المطلوبة',
            depositSuffix: '٪ من إجمالي العرض',
            depositHint: 'نسبة مئوية وليست مبلغًا — تُطبَّق على العرض المقبول أيًّا كان. أدخِلوا 0 إن لم تكن مطلوبة.',
            notesLabel: 'أي شيء آخر ينبغي أن نعرفه',
            notesPlaceholder: 'مدة التوريد، الضمان، شروط الدفع',
            countedSome: (n, m) => `عدد العروض: ${n}، ابتداءً من ${m}`,
            countedNone: 'أضيفوا عرضًا قبل الإرسال',
            send: 'إرسال عرض السعر',
            sending: 'جارٍ الإرسال…',

            editingTitle: (l) => `تعديل ${l}`,
            newOfferTitle: (n) => `عرض جديد (${n})`,
            draftNote: 'محفوظ على هذا الجهاز فقط حتى ترسلوا عرض السعر',
            optionNameLabel: 'اسم لهذا الخيار',
            optional: '(اختياري)',
            optionNamePlaceholder: 'مثال: العلامة الأصلية، أو بديل اقتصادي',
            optionNameHint: 'يظهر لمن يقارنون العروض. يُرجى عدم كتابة اسم شركتكم هنا — فالعروض تُقارَن دون معرفة أصحابها.',

            sectionAsked: 'البنود التي طلبناها',
            ledeAsked1: 'حدِّدوا ما يمكنكم توريده وتُملأ التفاصيل تلقائيًا — ولا تُدخلون سوى الكمية وسعر الوحدة. واتركوا البقية دون تحديد. والكمية لكم أن تحدِّدوها في الاتجاهين: <strong>أقلّ</strong> مما طلبناه إجابة مقبولة تمامًا (اثنان من ثلاثة مطلوبة، ونوفّر الباقي من مصدر آخر)، و<strong>أكثر</strong> مقبول أيضًا إن كان هذا هو شكل التوريد — علبة من عشرة، أو قطعة احتياطية مضافة.',
            ledeAsked2: 'أدخِلوا <strong>0</strong> كسعر لأي شيء تقدّمونه مجانًا: حقيبة مع الحاسوب، أو ملحق مرفق، أو عيّنة. لكن يُرجى عدم ترك خانة السعر فارغة — فالفراغ لا يُقرأ على أنه مجاني.',
            thCanSupply: 'يمكن توريده',
            thAskedFor: 'المطلوب',
            thQtyCan: 'الكمية التي يمكنكم توريدها',
            thUnitPrice: 'سعر الوحدة',
            thLineTotal: 'إجمالي السطر',
            nothingItemised: 'لم تُفصَّل بنود هذه المناقصة.',

            sectionInstead: 'ما تعرضونه بديلًا',
            ledeInstead: 'خاصّ بما ليس في القائمة أعلاه فقط — بديل لشيء لا يتوفَّر لديكم، أو إضافة مرفقة، أو هدية تضمّونها. اكتبوها بأنفسكم وحدِّدوا السطر الذي تحلّ محلّه — فالأرقام مطابقة للقائمة في أعلى الصفحة، وبذلك يبقى سطران بالاسم نفسه منفصلين. وسعِّروا الهدية بـ 0 لتظهر في عرض السعر دون أن تضيف إلى الإجمالي.',
            thStandsIn: 'يحلّ محلّ',
            thQty: 'الكمية',
            thUnit: 'الوحدة',
            thRemove: 'حذف',
            addOwnItem: 'أضيفوا بندًا من عندكم',
            offerNotesLabel: 'ملاحظات على هذا العرض',
            offerNotesPlaceholder: 'مدة التوريد، الضمان، سبب اقتراح البديل',
            offerTotal: 'إجمالي العرض',
            cancel: 'إلغاء',
            saveChanges: 'حفظ التعديلات',
            saveOffer: 'حفظ العرض',

            noSpec: 'لا توجد مواصفات',
            extraNothing: 'إضافة — ليست في القائمة',
            insteadOf: (n, name) => `بدلًا من #${n} ${name}`,
            phWhatOffering: 'ما تعرضونه',
            phMakeModel: 'الماركة، الطراز، المواصفات',
            phUnit: 'قطعة',
            ariaItemName: 'اسم البند',
            ariaSpec: 'المواصفات',
            ariaReplaces: 'ما يحلّ محلّه',
            ariaQty: 'الكمية',
            ariaUnit: 'الوحدة',
            ariaUnitPrice: 'سعر الوحدة',
            ariaRemoveRow: 'حذف هذا السطر',
            ariaCanSupply: (name) => `يمكننا توريد ${name}`,
            ariaHowMany: (name) => `الكمية التي يمكنكم توريدها من ${name}`,
            ariaUnitPriceFor: (name) => `سعر الوحدة لـ ${name}`,

            needQtyPrice: (list) => `يلزم إدخال كمية وسعر (أدخِلوا 0 إن كان مجانيًا): ${list}.`,
            yourOwnItem: (i) => `بندكم رقم ${i}`,
            tickAtLeastOne: 'حدِّدوا بندًا واحدًا على الأقل، أو أضيفوا بندًا من عندكم، قبل الحفظ.',
            savedOver: (list) => `حُفظ العرض. لاحِظوا أنكم سعّرتم أكثر مما طلبناه في: ${list}.`,
            savedOk: 'حُفظ العرض. لا يُرسَل شيء حتى ترسلوا عرض السعر.',
            confirmRemove: (l) => `حذف ${l}؟ لا يمكن التراجع عن ذلك.`,

            addAtLeastOne: 'أضيفوا عرضًا واحدًا على الأقل قبل الإرسال.',
            depositRange: 'الدفعة المقدَّمة نسبة مئوية، فيجب أن تكون بين 0 و100.',
            offerEmpty: (l) => `${l} لا يحتوي على أي تسعير. عدِّلوه أو احذفوه.`,
            submitFailed: 'تعذَّر إرسال عرض السعر.',
            receivedTitle: 'استُلم عرض السعر',
            receivedBody: (n, serial) => `شكرًا لكم. سُجِّلت عروضكم الخاصة بالمناقصة ${serial} وعددها ${n}، ولم يعد بالإمكان تعديلها. وسيتواصل معكم فريق المشتريات.`,

            nothingToOpen: 'لا يوجد ما يُفتَح هنا',
            nothingToOpenBody: 'تحتاج هذه الصفحة إلى رابط الدعوة المُرسَل إليكم. يُرجى فتح الرابط من بريدكم بدلًا من كتابة العنوان يدويًا.',
            linkInvalid: 'هذا الرابط غير صالح',
            linkInvalidBody: 'ربما جرى سحبه، أو ربما نُسخ العنوان ناقصًا. يُرجى التواصل مع فريق المشتريات الذي أرسله.',
            docTitle: (serial) => `عرض سعر — ${serial}`,
            formClosed: 'هذا النموذج مغلق',
            formClosedBody: 'هذه المناقصة لا تقبل عروض أسعار.',
            pickedUp: (n) => `استُعيدت عروض غير مُرسَلة من زيارتكم السابقة، وعددها ${n}.`,
        },
    };

    function pick() {
        const asked = new URLSearchParams(window.location.search).get('lang');
        if (asked && SUPPORTED.includes(asked)) return asked;
        let saved = null;
        try { saved = localStorage.getItem(STORE); } catch (err) { saved = null; }
        if (saved && SUPPORTED.includes(saved)) return saved;
        return (navigator.language || 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
    }

    const I18N = {
        lang: pick(),
        other() { return this.lang === 'ar' ? 'en' : 'ar'; },
        rtl() { return this.lang === 'ar'; },
        locale() { return this.lang === 'ar' ? 'ar-EG-u-nu-latn' : undefined; },
        t(key, ...args) {
            const table = STRINGS[this.lang] || STRINGS.en;
            const value = table[key] !== undefined ? table[key] : STRINGS.en[key];
            if (value === undefined) return key;
            return typeof value === 'function' ? value(...args) : value;
        },
        apply() {
            const html = document.documentElement;
            html.lang = this.lang;
            html.dir = this.rtl() ? 'rtl' : 'ltr';
        },
        set(lang) {
            if (!SUPPORTED.includes(lang)) return;
            this.lang = lang;
            try { localStorage.setItem(STORE, lang); } catch (err) {  }
            this.apply();
        },
    };

    window.I18N = I18N;
    I18N.apply();
}());
