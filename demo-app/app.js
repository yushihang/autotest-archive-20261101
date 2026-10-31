/* Demo app 行为：登录校验 + 内存待办列表。零依赖、无构建、无随机数/时间戳。 */
(function () {
  'use strict';

  var loginSection = document.getElementById('login-section');
  var loginForm = document.getElementById('login-form');
  var emailInput = document.getElementById('email');
  var passwordInput = document.getElementById('password');
  var loginError = document.getElementById('login-error');
  var loginStatus = document.getElementById('login-status');
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
  // 列表整表重建后要把焦点放回哪个元素（见 render）。
  var focusRequest = null;

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

  // 用户改正输入后立刻收起旧错误，不必等到再次提交。
  function clearErrorOnInput(input) {
    input.addEventListener('input', function () {
      if (loginError.textContent !== '') {
        clearError();
      }
    });
  }

  clearErrorOnInput(emailInput);
  clearErrorOnInput(passwordInput);

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
    loginSection.hidden = true;
    welcomeText.textContent = '欢迎，' + email;
    // 先在常驻的 live region 里写内容，再显示视觉区块：
    // hidden 元素从隐藏变可见时，读屏软件不会保证播报其内容。
    loginStatus.textContent = '欢迎，' + email;
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

  // 某条待办离开可见列表后，焦点该落到哪个元素：
  // 优先原位置的下一条，其次上一条，都没有就回到输入框。
  function focusIdAfterRemoval(index) {
    var remaining = visibleTodos();
    var next = remaining[index] || remaining[index - 1];
    return next ? 'todo-' + next.id + '-toggle' : 'todo-input';
  }

  function render() {
    // 整表重建会让当前焦点节点消失、焦点掉回 body，先记下要回到哪个元素。
    var active = document.activeElement;
    var restoreId = focusRequest;
    if (restoreId === null && active && active.id && todoList.contains(active)) {
      restoreId = active.id;
    }
    focusRequest = null;

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
        var index = visibleTodos().indexOf(todo);
        todo.completed = toggle.checked;
        var stillVisible = visibleTodos().indexOf(todo) !== -1;
        focusRequest = stillVisible ? toggle.id : focusIdAfterRemoval(index);
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
        var index = visibleTodos().indexOf(todo);
        todos = todos.filter(function (candidate) {
          return candidate.id !== todo.id;
        });
        focusRequest = focusIdAfterRemoval(index);
        render();
      });

      item.appendChild(toggle);
      item.appendChild(title);
      item.appendChild(remove);
      todoList.appendChild(item);
    });

    var target = restoreId === null ? null : document.getElementById(restoreId);
    if (target !== null) {
      target.focus();
    }
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
    // 中文/日文输入法用 Enter 上屏候选词时也会派发 key === 'Enter' 的 keydown，
    // 此时输入框里还是未上屏的拼音串，必须跳过，否则会误加一条待办并清空输入。
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
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
