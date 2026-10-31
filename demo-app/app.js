/* Demo app 行为：登录校验 + 内存待办列表。零依赖、无构建、无随机数/时间戳。 */
(function () {
  'use strict';

  var loginForm = document.getElementById('login-form');
  var emailInput = document.getElementById('email');
  var passwordInput = document.getElementById('password');
  var loginError = document.getElementById('login-error');
  var welcome = document.getElementById('welcome');
  var welcomeText = document.getElementById('welcome-text');

  var todoInput = document.getElementById('todo-input');
  var todoAdd = document.getElementById('todo-add');
  var todoList = document.getElementById('todo-list');
  var filterButtons = Array.prototype.slice.call(
    document.querySelectorAll('[data-filter]')
  );

  // 页面内存状态，刷新即重置。
  var todos = [];
  var nextId = 1;
  var activeFilter = 'all';

  function showError(message) {
    loginError.textContent = message;
    loginError.hidden = false;
  }

  function clearError() {
    loginError.textContent = '';
    loginError.hidden = true;
  }

  function validateLogin(email, password) {
    if (email === '') {
      return '请输入邮箱地址';
    }
    if (password === '') {
      return '请输入密码';
    }
    if (email.indexOf('@') === -1) {
      return '邮箱格式不正确';
    }
    return null;
  }

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = emailInput.value.trim();
    var password = passwordInput.value;

    var error = validateLogin(email, password);
    if (error !== null) {
      showError(error);
      return;
    }

    clearError();
    loginForm.hidden = true;
    welcomeText.textContent = '欢迎，' + email;
    welcome.hidden = false;
  });

  function visibleTodos() {
    return todos.filter(function (todo) {
      if (activeFilter === 'active') {
        return !todo.completed;
      }
      if (activeFilter === 'completed') {
        return todo.completed;
      }
      return true;
    });
  }

  function render() {
    todoList.textContent = '';

    visibleTodos().forEach(function (todo) {
      var item = document.createElement('li');
      item.id = 'todo-' + todo.id;
      item.setAttribute('data-testid', 'todo-item');
      item.setAttribute('data-completed', todo.completed ? 'true' : 'false');

      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'todo-toggle';
      toggle.id = 'todo-' + todo.id + '-toggle';
      toggle.checked = todo.completed;
      toggle.setAttribute('data-testid', 'todo-toggle');
      toggle.setAttribute('aria-label', '完成：' + todo.title);
      toggle.addEventListener('change', function () {
        todo.completed = toggle.checked;
        render();
      });

      var title = document.createElement('span');
      title.className = 'todo-title' + (todo.completed ? ' done' : '');
      title.setAttribute('data-testid', 'todo-title');
      title.textContent = todo.title;

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'todo-delete';
      remove.id = 'todo-' + todo.id + '-delete';
      remove.setAttribute('data-testid', 'todo-delete');
      remove.textContent = '删除';
      remove.setAttribute('aria-label', '删除：' + todo.title);
      remove.addEventListener('click', function () {
        todos = todos.filter(function (candidate) {
          return candidate.id !== todo.id;
        });
        render();
      });

      item.appendChild(toggle);
      item.appendChild(title);
      item.appendChild(remove);
      todoList.appendChild(item);
    });
  }

  function addTodo() {
    var title = todoInput.value.trim();
    if (title === '') {
      return;
    }
    todos.push({ id: nextId, title: title, completed: false });
    nextId += 1;
    todoInput.value = '';
    render();
  }

  todoAdd.addEventListener('click', addTodo);

  todoInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTodo();
    }
  });

  filterButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      activeFilter = button.getAttribute('data-filter');
      filterButtons.forEach(function (other) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
      render();
    });
  });

  render();
})();
