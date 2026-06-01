// static/js/main.js

document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('search-btn')) {
        initSearchPage();
    }
    if (document.getElementById('subcategory-list')) {
        initCatalogPage();
    }
});

let currentQuery = ""; 

function initSearchPage() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    const hybridSlider = document.getElementById('hybrid-slider');
    const sliderVal = document.getElementById('slider-value');
    const randomBtn = document.getElementById('random-btn');
    const feedbackSubmit = document.getElementById('submit-feedback-btn');

    hybridSlider.addEventListener('input', function() {
        const val = Math.round(this.value * 100);
        sliderVal.innerText = `BERT: ${val}% | TF-IDF: ${100 - val}%`;
        if (currentQuery) {
            triggerSearch(currentQuery, this.value);
        }
    });

    searchBtn.addEventListener('click', () => {
        currentQuery = searchInput.value.trim();
        if(currentQuery) triggerSearch(currentQuery, hybridSlider.value);
    });

    searchInput.addEventListener('keypress', (e) => {
        if(e.key === 'Enter') {
            currentQuery = searchInput.value.trim();
            if(currentQuery) triggerSearch(currentQuery, hybridSlider.value);
        }
    });

    randomBtn.addEventListener('click', triggerRandomBook);
    feedbackSubmit.addEventListener('click', submitFeedback);
}

function triggerSearch(query, alpha) {
    const resultsContainer = document.getElementById('results-container');
    const feedbackAlert = document.getElementById('feedback-alert-zone');
    
    resultsContainer.innerHTML = `
        <div class="text-center my-5">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 text-muted">Умный ИИ-гибрид пересчитывает матрицы сходства...</p>
        </div>`;
    feedbackAlert.classList.add('d-none');

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, alpha: alpha })
    })
    .then(res => res.json())
    .then(books => {
        resultsContainer.innerHTML = "";
        
        if (books.length === 0) {
            resultsContainer.innerHTML = `<div class="alert alert-warning text-center">Ничего не найдено. Попробуйте изменить запрос.</div>`;
            return;
        }

        document.getElementById('feedback-trigger-zone').classList.remove('d-none');

        books.forEach((book, index) => {
            let tagsHtml = book.themes.map(t => `<span class="theme-tag">#${t}</span>`).join('');
            
            let cardHtml = `
            <div class="card book-card shadow-sm mb-4">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <div>
                            <span class="badge bg-primary mb-2">#${index + 1} в выдаче</span>
                            <h4 class="card-title mb-1 text-dark">${book.title}</h4>
                            <h6 class="card-subtitle text-muted mb-2">${book.author} | <small>${book.subcategory}</small></h6>
                        </div>
                        <div class="text-end">
                            <span class="badge bg-success score-badge d-block mb-1">Сходство: ${book.score}%</span>
                            <small class="text-muted d-block" style="font-size:0.75rem;">BERT: ${book.bert_score}% | TF-IDF: ${book.tfidf_score}%</small>
                        </div>
                    </div>
                    <div class="mt-2">${tagsHtml}</div>
                    <hr>
                    <p class="card-text text-secondary">${book.annotation}</p>
                </div>
            </div>`;
            resultsContainer.innerHTML += cardHtml;
        });
    });
}

function triggerRandomBook() {
    const modalBody = document.getElementById('randomBookModalBody');
    const myModal = new bootstrap.Modal(document.getElementById('randomBookModal'));
    
    modalBody.innerHTML = '<div class="text-center"><div class="spinner-border text-primary"></div></div>';
    myModal.show();

    fetch('/api/random')
    .then(res => res.json())
    .then(book => {
        let tagsHtml = book.themes.map(t => `<span class="theme-tag">#${t}</span>`).join('');
        modalBody.innerHTML = `
            <h3>${book.title}</h3>
            <h5 class="text-muted">${book.author}</h5>
            <span class="badge bg-secondary mb-3">${book.subcategory}</span>
            <div class="mb-3">${tagsHtml}</div>
            <p class="text-dark" style="line-height:1.6;">${book.annotation}</p>
        `;
    });
}

function submitFeedback() {
    const bookTitleInput = document.getElementById('feedback-book-title');
    const title = bookTitleInput.value.trim();
    const alertZone = document.getElementById('feedback-alert-zone');
    
    if(!title || !currentQuery) return;

    fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: currentQuery, book_title: title })
    })
    .then(res => res.json())
    .then(data => {
        const myModalEl = document.getElementById('feedbackModal');
        const modal = bootstrap.Modal.getInstance(myModalEl);
        modal.hide();
        
        bookTitleInput.value = "";

        alertZone.className = `alert mt-4 ${data.status === 'exists' ? 'alert-info' : 'alert-success'}`;
        alertZone.innerText = data.message;
        alertZone.classList.remove('d-none');
    });
}

// УПРАВЛЕНИЕ СТРАНИЦЕЙ КАТАЛОГА
let currentSubcat = "Все жанры";
let currentAuthor = "Все авторы";
let currentTitleQuery = "";
let selectedThemesArray = []; 
let currentPage = 1;

function initCatalogPage() {
    // Принудительно запрашиваем построение тегов при первом открытии каталога
    loadCatalogBooks(true); 

    // 1. Клики по левому меню жанров
    document.querySelectorAll('.subcat-item').forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            document.querySelectorAll('.subcat-item').forEach(i => i.classList.remove('active'));
            this.classList.add('active');
            
            currentSubcat = this.dataset.subcat ? this.dataset.subcat : "Все жанры";
            
            // Полный сброс параметров
            currentAuthor = "Все авторы";
            document.getElementById('catalog-author-input').value = "";
            currentTitleQuery = "";
            document.getElementById('catalog-title-search').value = "";
            selectedThemesArray = []; 

            currentPage = 1;
            loadCatalogBooks(true); 
        });
    });

    // 2. Живой ввод автора с умным облаком подсказок и приоритетом первой буквы
let authorTimer;
const authorInput = document.getElementById('catalog-author-input');
const authorDropdown = document.getElementById('author-dropdown');

authorInput.addEventListener('input', function() {
    clearTimeout(authorTimer);
    let val = this.value.trim();
    
    // Если поле ввода пустое, сбрасываем фильтр, прячем выпадашку и обновляем книги
    if (!val) {
        currentAuthor = "Все авторы";
        currentPage = 1;
        authorDropdown.classList.add('d-none');
        authorTimer = setTimeout(() => { loadCatalogBooks(false); }, 300);
        return;
    }

    const query = val.toLowerCase();
    const allAuthors = window.currentAuthorsList || [];

    // Группа 1: Авторы, которые НАЧИНАЮТСЯ на введенный текст (Пушкин, По)
    // Так как исходный массив allAuthors уже отсортирован бэкендом по популярности,
    // внутри этой группы автоматически сохранится правильный порядок!
    const startsWithQuery = allAuthors.filter(a => a.toLowerCase().startsWith(query));

    // Группа 2: Все остальные авторы, у которых текст встречается в середине или инициалах (Чехов А.П.)
    const containsQuery = allAuthors.filter(a => 
        !a.toLowerCase().startsWith(query) && a.toLowerCase().includes(query)
    );

    // Объединяем списки: сначала те, кто НАЧИНАЕТСЯ на нужную букву, затем остальные совпадения
    const filtered = [...startsWithQuery, ...containsQuery];
    
    const containerInner = authorDropdown.querySelector('.list-group-inner');
    if (filtered.length > 0) {
        let html = '';
        filtered.forEach(author => {
            const safeName = author.replace(/'/g, "\\'");
            
            // Визуально выделим авторов, которые начинаются на эту букву (добавим легкий акцент),
            // чтобы на фронтенде это смотрелось еще круче
            const isPrimary = author.toLowerCase().startsWith(query);
            const textClass = isPrimary ? 'fw-semibold text-dark' : 'text-muted';

            html += `
                <button type="button" class="list-group-item list-group-item-action py-2 text-start border-0 small ${textClass}" onclick="selectCatalogAuthor('${safeName}')">
                    <i class="bi ${isPrimary ? 'bi-person-check-fill text-primary' : 'bi-person text-muted'} me-2"></i>${author}
                </button>`;
        });
        containerInner.innerHTML = html;
        authorDropdown.classList.remove('d-none');
    } else {
        containerInner.innerHTML = '<div class="list-group-item text-muted small border-0">Автор не найден</div>';
        authorDropdown.classList.remove('d-none');
    }

    // Запускаем фоновый поиск по книгам фонда
    currentAuthor = val;
    currentPage = 1;
    authorTimer = setTimeout(() => { loadCatalogBooks(false); }, 500);
});

// Прячем выпадашку, если кликнули мимо инпута и мимо самого меню подсказок
document.addEventListener('click', function(e) {
    if (e.target !== authorInput && !authorDropdown.contains(e.target)) {
        authorDropdown.classList.add('d-none');
    }
});


// Функция срабатывает, когда пользователь кликает по автору в красивом списке
window.selectCatalogAuthor = function(authorName) {
    const authorInput = document.getElementById('catalog-author-input');
    const authorDropdown = document.getElementById('author-dropdown');
    
    authorInput.value = authorName; // Подставляем имя в инпут
    currentAuthor = authorName;     // Записываем в переменную фильтра
    currentPage = 1;
    
    authorDropdown.classList.add('d-none'); // Скрываем облако подсказок
    loadCatalogBooks(false);               // Мгновенно обновляем книги каталога
}
    // 3. Живой поиск по названию книги
    let titleTimer;
    document.getElementById('catalog-title-search').addEventListener('input', function() {
        clearTimeout(titleTimer);
        currentTitleQuery = this.value.trim();
        currentPage = 1;
        titleTimer = setTimeout(() => { loadCatalogBooks(false); }, 350);
    });
}

function loadCatalogBooks(shouldUpdateThemes = false) {
    const grid = document.getElementById('catalog-grid');
    grid.innerHTML = '<div class="text-center col-12 my-5"><div class="spinner-border text-primary"></div></div>';

    const themesQuery = selectedThemesArray.join(',');
    const url = `/api/books?subcategory=${encodeURIComponent(currentSubcat)}&author=${encodeURIComponent(currentAuthor)}&title_query=${encodeURIComponent(currentTitleQuery)}&themes=${encodeURIComponent(themesQuery)}&page=${currentPage}`;

    fetch(url)
    .then(res => res.json())
    .then(data => {
        grid.innerHTML = "";
        
        document.getElementById('catalog-title').innerText = currentSubcat === "Все жанры" ? "Все книги фонда" : currentSubcat;
        document.getElementById('total-books-count').innerText = data.total_books;

        updateDatalistAuthors(data.authors);
        
        if (shouldUpdateThemes) {
            renderDynamicThemes(data.themes);
        }

        if(data.books.length === 0) {
            grid.innerHTML = '<div class="alert alert-light border text-center col-12 py-4 text-muted">По заданным критериям и тегам книг не найдено.</div>';
            document.getElementById('catalog-pagination').innerHTML = "";
            return;
        }

        data.books.forEach(book => {
            let tagsHtml = book.themes.map(t => `<span class="theme-tag">#${t}</span>`).join('');
            grid.innerHTML += `
                <div class="col-md-4 mb-4">
                    <div class="card h-100 shadow-sm book-card">
                        <div class="card-body d-flex flex-column">
                            <span class="badge bg-secondary align-self-start mb-2" style="font-size:0.7rem;">${book.subcategory}</span>
                            <h5 class="card-title text-dark mb-1 fw-bold">${book.title}</h5>
                            <h6 class="card-subtitle mb-3 text-muted" style="font-size:0.9rem;"><i class="bi bi-person me-1"></i>${book.author}</h6>
                            <p class="card-text text-secondary flex-grow-1" style="font-size:0.85rem; line-height: 1.5;">${book.annotation}</p>
                            <div class="mt-2">${tagsHtml}</div>
                        </div>
                    </div>
                </div>
            `;
        });
        
        buildPagination(data.total_pages, data.current_page);
    });
}

function renderDynamicThemes(themesList) {
    const container = document.getElementById('dynamic-themes-container');
    container.innerHTML = "";

    if (!themesList || themesList.length === 0) {
        container.innerHTML = '<span class="text-muted" style="font-size:0.85rem;">Нет доступных тегов сюжета</span>';
        return;
    }

    themesList.forEach((theme, index) => {
        const isChecked = selectedThemesArray.includes(theme);
        
        const wrapper = document.createElement('div');
        // Оставляем inline-блоки без лишних стандартных отступов
        wrapper.className = "d-inline-block m-1"; 
        
        // Делаем скрытый чекбокс input (d-none) и красивый label в виде овального badge
        wrapper.innerHTML = `
            <input class="dynamic-theme-cb d-none" type="checkbox" value="${theme}" id="dt-cb-${index}" ${isChecked ? 'checked' : ''}>
            <label class="badge-tag-oval ${isChecked ? 'active' : ''}" for="dt-cb-${index}">#${theme}</label>
        `;
        
        container.appendChild(wrapper);
    });

    // Навешиваем обработчик клика на овальные плашки
    document.querySelectorAll('.dynamic-theme-cb').forEach(cb => {
        cb.addEventListener('change', function() {
            const label = document.querySelector(`label[for="${this.id}"]`);
            if (this.checked) {
                label.classList.add('active'); // Окрашиваем в синий при активации
                if (!selectedThemesArray.includes(this.value)) {
                    selectedThemesArray.push(this.value);
                }
            } else {
                label.classList.remove('active'); // Возвращаем серый цвет при снятии
                selectedThemesArray = selectedThemesArray.filter(t => t !== this.value);
            }
            currentPage = 1;
            loadCatalogBooks(false); // Мгновенно фильтруем книги без перезагрузки панели тегов
        });
    });
}

function updateDatalistAuthors(authorsList) {
    // Сохраняем полученный от бэкенда упорядоченный список авторов в глобальную переменную окна,
    // чтобы использовать его для живой фильтрации при вводе букв
    window.currentAuthorsList = authorsList || [];
}

function buildPagination(totalPages, activePage) {
    const nav = document.getElementById('catalog-pagination');
    nav.innerHTML = "";
    if(totalPages <= 1) return;

    let html = '<ul class="pagination justify-content-center">';
    for(let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= activePage - 2 && i <= activePage + 2)) {
            html += `<li class="page-item ${i === activePage ? 'active' : ''}"><a class="page-link" href="#" onclick="changePage(${i})">${i}</a></li>`;
        } else if (i === activePage - 3 || i === activePage + 3) {
            html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
        }
    }
    html += '</ul>';
    nav.innerHTML = html;
}

window.changePage = function(page) {
    currentPage = page;
    loadCatalogBooks(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
};