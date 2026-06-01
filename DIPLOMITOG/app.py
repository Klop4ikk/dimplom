import os
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

import json
import random
import pandas as pd
import numpy as np
import pickle
from flask import Flask, render_template, request, jsonify
from sklearn.feature_extraction.text import TfidfVectorizer
from sentence_transformers import SentenceTransformer, util

app = Flask(__name__)

# ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ДЛЯ МОДЕЛЕЙ И ДАННЫХ 
df = None
books_embeddings = None
bert_model = None
tfidf_vectorizer = None
tfidf_matrix = None

# обученная модель и актуальный датасет соавторов
DATASET_FILE = 'books_dataset_multiauthor.csv'
MODEL_PATH = './my_finetuned_rubert'
EMBEDDINGS_FILE = 'books_embeddings.pkl'
FEEDBACK_FILE = 'user_feedback.json'

def init_models():
    global df, books_embeddings, bert_model, tfidf_vectorizer, tfidf_matrix
    print("🤖 Загрузка датасета и инициализация моделей... Пожалуйста, подождите.")
    
    # 1. Загрузка датасета
    if os.path.exists(DATASET_FILE):
        df = pd.read_csv(DATASET_FILE)
    else:
        df = pd.read_csv('books_dataset_production.csv')

    df['title'] = df['title'].fillna('Без названия')
    df['author'] = df['author'].fillna('Неизвестный автор')
    df['annotation'] = df['annotation'].fillna('')
    
    # Защита от отсутствия колонок категорий в датасете
    df['subcategory'] = df['subcategory'].fillna('Разное') if 'subcategory' in df.columns else 'Разное'
    df['themes'] = df['themes'].fillna('') if 'themes' in df.columns else ''
    
    # Убираем дубликаты
    df.drop_duplicates(subset=['title', 'author'], keep='first', inplace=True)
    df.reset_index(drop=True, inplace=True)

    # 2. Инициализация RuBERT модели
    print(f"🧠 Загрузка твоей обученной модели из {MODEL_PATH}...")
    bert_model = SentenceTransformer(MODEL_PATH, device='cpu')

    # Формируем текстовое представление для векторизации
    book_texts = []
    for _, row in df.iterrows():
        book_texts.append(f"Название: {row['title']}. Автор: {row['author']}. Описание: {row['annotation']}")

    # 3. Загрузка или генерация новых эмбеддингов
    if os.path.exists(EMBEDDINGS_FILE):
        print("📥 Загрузка сохраненных эмбеддингов из файла...")
        with open(EMBEDDINGS_FILE, 'rb') as f:
            books_embeddings = pickle.load(f)
            
        # Проверка на синхронность размеров
        if len(books_embeddings) != len(df):
            print("⚠️ Размер базы изменился! Пересчитываем векторы...")
            books_embeddings = bert_model.encode(book_texts, convert_to_tensor=True, show_progress_bar=True)
            with open(EMBEDDINGS_FILE, 'wb') as f:
                pickle.dump(books_embeddings, f)
    else:
        print("🔥 Эмбеддинги не найдены. Генерируем новые векторы по твоей модели...")
        books_embeddings = bert_model.encode(book_texts, convert_to_tensor=True, show_progress_bar=True)
        with open(EMBEDDINGS_FILE, 'wb') as f:
            pickle.dump(books_embeddings, f)

    # 4. Инициализация и обучение TF-IDF по актуальным аннотациям
    tfidf_vectorizer = TfidfVectorizer(max_features=10000)
    tfidf_matrix = tfidf_vectorizer.fit_transform(df['annotation'])
    
    print(f"✅ Модели успешно синхронизированы! Доступно уникальных книг: {len(df)}")

# ВСПОМОГАТЕЛЬНАЯ ЛОГИКА ДЛЯ ФИДБЕКА 
def save_feedback(data):
    feedback_list = []
    if os.path.exists(FEEDBACK_FILE):
        try:
            with open(FEEDBACK_FILE, 'r', encoding='utf-8') as f:
                feedback_list = json.load(f)
        except Exception:
            feedback_list = []
    
    feedback_list.append(data)
    with open(FEEDBACK_FILE, 'w', encoding='utf-8') as f:
        json.dump(feedback_list, f, ensure_ascii=False, indent=4)

# МАРШРУТЫ САЙТА
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/catalog')
def catalog():
    subcategories = sorted(df['subcategory'].unique().tolist())
    return render_template('catalog.html', subcategories=subcategories)

# API ЭНДПОИНТЫ ДЛЯ AJAX 
@app.route('/api/search', methods=['POST'])
def api_search():
    global df, books_embeddings, bert_model, tfidf_vectorizer, tfidf_matrix
    
    data = request.json
    query = data.get('query', '').strip()
    alpha = float(data.get('alpha', 0.5)) 
    
    if not query:
        return jsonify([])

    # 1. Расчет BERT-сходства с моделью
    query_embedding = bert_model.encode(query, convert_to_tensor=True)
    bert_sims = util.cos_sim(query_embedding, books_embeddings).cpu().numpy()[0]
    bert_sims = (bert_sims - bert_sims.min()) / (bert_sims.max() - bert_sims.min() + 1e-8)

    # 2. Расчет TF-IDF сходства
    query_tfidf = tfidf_vectorizer.transform([query])
    from sklearn.metrics.pairwise import cosine_similarity
    tfidf_sims = cosine_similarity(query_tfidf, tfidf_matrix).flatten()
    if tfidf_sims.max() > tfidf_sims.min():
        tfidf_sims = (tfidf_sims - tfidf_sims.min()) / (tfidf_sims.max() - tfidf_sims.min() + 1e-8)

    # 3. Гибридное ранжирование
    final_scores = alpha * bert_sims + (1 - alpha) * tfidf_sims
    
    # 4. Поиск ТОП кандидатов с фильтрацией дубликатов
    top_candidate_indices = np.argsort(final_scores)[::-1][:50]
    
    results = []
    seen_titles = set()

    for idx in top_candidate_indices:
        if len(results) >= 5:
            break
            
        raw_title = str(df.loc[idx, 'title']).strip()
        clean_title = raw_title.lower()
        for marker in ['(с иллюстрациями)', 'подарочное издание', 'новый перевод', 'иллюстрированное', 'специальное издание']:
            clean_title = clean_title.replace(marker, '').strip()
        
        has_special_marker = any(m in raw_title.lower() for m in ['(с иллюстрациями)', 'подарочное', 'перевод', 'ил.'])

        if clean_title in seen_titles and not has_special_marker:
            continue
            
        seen_titles.add(clean_title)
        
        annot = df.loc[idx, 'annotation']
        short_annot = annot if len(annot) <= 300 else annot[:300] + '...'
        
        themes_raw = df.loc[idx, 'themes'] if 'themes' in df.columns else ''
        themes_list = [t.strip() for t in str(themes_raw).split(',') if t.strip()]

        display_author = str(df.loc[idx, 'author']).replace("; ", ", ")

        results.append({
            'id': int(idx),
            'title': raw_title,
            'author': display_author,
            'subcategory': df.loc[idx, 'subcategory'] if 'subcategory' in df.columns else 'Разное',
            'themes': themes_list[:4], 
            'annotation': short_annot,
            'full_annotation': annot,
            'score': round(float(final_scores[idx]) * 100, 2),
            'bert_score': round(float(bert_sims[idx]) * 100, 2),
            'tfidf_score': round(float(tfidf_sims[idx]) * 100, 2)
        })
        
    return jsonify(results)

@app.route('/api/random', methods=['GET'])
def api_random():
    if df is None or len(df) == 0:
        return jsonify({})
    random_idx = random.randint(0, len(df) - 1)
    row = df.iloc[random_idx]
    
    themes_raw = row['themes'] if 'themes' in df.columns else ''
    themes_list = [t.strip() for t in str(themes_raw).split(',') if t.strip()]
    
    display_author = str(row['author']).replace("; ", ", ")

    return jsonify({
        'title': row['title'],
        'author': display_author,
        'subcategory': row['subcategory'] if 'subcategory' in df.columns else 'Разное',
        'themes': themes_list[:4],
        'annotation': row['annotation']
    })

@app.route('/api/books', methods=['GET'])
def api_get_books():
    subcat = request.args.get('subcategory', '').strip()
    author_filter = request.args.get('author', '').strip()
    title_query = request.args.get('title_query', '').strip()
    themes_query = request.args.get('themes', '').strip()
    
    page = int(request.args.get('page', 1))
    per_page = 12
    
    base_df = df.copy()
    
    # 1. Фильтрация по жанру (подкатегории)
    if subcat and subcat != 'Все жанры':
        base_df = base_df[base_df['subcategory'] == subcat]
        
    # 2. Умный поиск автора по вхождению (поддерживает разделение '; ')
    if author_filter and author_filter != 'Все авторы':
        base_df = base_df[base_df['author'].str.contains(author_filter, case=False, na=False)]
        
    # 3. Сортировка с приоритетом первого слова в названии
    if title_query:
        base_df = base_df[base_df['title'].str.contains(title_query, case=False, na=False)]
        
        if not base_df.empty:
            starts_with_query = base_df['title'].str.lower().str.startswith(title_query.lower())
            base_df['search_priority'] = np.where(starts_with_query, 1, 2)
            base_df = base_df.sort_values(by='search_priority')
            base_df = base_df.drop(columns=['search_priority'])
        
    # Сбор уникальных тегов (themes) для текущей выборки
    all_themes_set = set()
    if 'themes' in base_df.columns:
        for row_themes in base_df['themes'].dropna():
            for t in str(row_themes).split(','):
                cleaned_tag = t.strip().lower()
                if cleaned_tag and cleaned_tag != 'nan' and len(cleaned_tag) > 1:
                    all_themes_set.add(cleaned_tag)
    
    available_themes = sorted(list(all_themes_set))
    
    # 4. Фильтрация по выбранным тегам (themes)
    filtered_df = base_df.copy()
    if themes_query:
        selected_themes = [t.strip().lower() for t in themes_query.split(',') if t.strip()]
        if selected_themes:
            def match_themes(row_themes):
                if pd.isna(row_themes): return False
                row_themes_list = [t.strip().lower() for t in str(row_themes).split(',')]
                return all(theme in row_themes_list for theme in selected_themes)
            
            filtered_df = filtered_df[filtered_df['themes'].apply(match_themes)]
        
    total_books = len(filtered_df)
    start_idx = (page - 1) * per_page
    end_idx = start_idx + per_page
    
    paginated_df = filtered_df.iloc[start_idx:end_idx]
    
    books_list = []
    for _, row in paginated_df.iterrows():
        themes_raw = row['themes'] if 'themes' in df.columns else ''
        themes_list = [t.strip() for t in str(themes_raw).split(',') if t.strip()]
        annot = row['annotation']
        short_annot = annot if len(annot) <= 140 else annot[:140] + '...'
        
        # Меняем системный разделитель '; ' на красивую запятую для карточки на сайте
        display_author = str(row['author']).replace("; ", ", ")

        books_list.append({
            'title': row['title'],
            'author': display_author,
            'subcategory': row['subcategory'] if 'subcategory' in df.columns else 'Разное',
            'themes': themes_list,
            'annotation': short_annot
        })
        
    # ====================================================================
    # 🔥 УМНАЯ СОРТИРОВКА АВТОРОВ ПО ПОПУЛЯРНОСТИ С РАЗБОРКАМИ СОАВТОРОВ
    # ====================================================================
    all_individual_authors = []
    for author_str in base_df['author'].dropna():
        parts = [a.strip() for a in str(author_str).split(";")]
        all_individual_authors.extend(parts)
    
    author_counts = pd.Series(all_individual_authors).value_counts()
    
    found_unknown = None
    for name in author_counts.index:
        if name.strip().lower() == 'неизвестный автор':
            found_unknown = name
            break

    if found_unknown and found_unknown in author_counts:
        author_counts = author_counts.drop(found_unknown)
        available_authors = author_counts.index.tolist()
        available_authors.append(found_unknown)
    else:
        available_authors = author_counts.index.tolist()
        
    return jsonify({
        'books': books_list,
        'total_pages': (total_books + per_page - 1) // per_page,
        'current_page': page,
        'total_books': total_books,
        'authors': available_authors,
        'themes': available_themes
    })

@app.route('/api/feedback', methods=['POST'])
def api_feedback():
    global df
    data = request.json
    user_query = data.get('query', '').strip()
    book_title = data.get('book_title', '').strip()
    
    if not user_query or not book_title:
        return jsonify({'status': 'error', 'message': 'Заполните все поля'}), 400
        
    match = df[df['title'].str.lower() == book_title.lower()]
    
    if len(match) > 0:
        display_author = str(match.iloc[0]['author']).replace("; ", ", ")
        save_feedback({
            'type': 'existing_book_enrichment',
            'query': user_query,
            'matched_title': match.iloc[0]['title'],
            'matched_author': display_author
        })
        return jsonify({
            'status': 'exists', 
            'message': f'Книга «{match.iloc[0]["title"]}» найдена в нашей базе! Мы сохранили ваш запрос. Он будет использован для дообучения модели, чтобы в следующий раз по этому описанию книга выводилась сразу в ТОП-5.'
        })
    else:
        save_feedback({
            'type': 'new_book_addition',
            'query': user_query,
            'requested_title': book_title
        })
        return jsonify({
            'status': 'new',
            'message': f'Этой книги пока нет в нашей библиотеке. Мы зафиксировали её название и ваше описание! В ближайшем обновлении она будет внесена в датасет, а векторы семантического поиска будут пересчитаны.'
        })

if __name__ == '__main__':
    init_models()
    app.run(host='0.0.0.0', port=5000, debug=True)